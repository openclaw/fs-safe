import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// One behavioral suite through the public surface, also runnable against the
// built artifact. Keep loader fault injection in the same module graph.
import type { RetainEntryForPublicationOptions, RetainedEntryPublication } from "../src/advanced.js";
import type { NativeBinding } from "../src/native.js";
const compiled = process.env.FS_SAFE_TEST_PUBLIC_ARTIFACT === "1";
const { retainEntryForPublication } = compiled ? await import("../dist/advanced.js") : await import("../src/advanced.js");
const { configureFsSafeNative, __resetFsSafeNativeConfigForTest } = compiled
  ? await import("../dist/native-config.js") : await import("../src/native-config.js");
const { __loadBundledNativeForTest, __setNativeLoaderForTest, __resetNativeLoaderForTest } = compiled
  ? await import("../dist/native.js") : await import("../src/native.js");

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* JS-only lanes prove refusal below. */ }
const posix = process.platform === "darwin" || process.platform === "linux";
const roots: string[] = [];
const operations: RetainedEntryPublication[] = [];
function stat(name: string) { return fs.lstatSync(name, { bigint: true }); }
function fixture(kind: "directory" | "file" = "directory") {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-entry-publication-")));
  roots.push(root);
  const sourceParent = path.join(root, "staging"), destinationParent = path.join(root, "target-parent");
  fs.mkdirSync(sourceParent); fs.mkdirSync(destinationParent);
  const source = path.join(sourceParent, "entry"), destination = path.join(destinationParent, "entry");
  if (kind === "directory") { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "bytes"), "original"); }
  else fs.writeFileSync(source, "original");
  const options: RetainEntryForPublicationOptions = {
    source: { parent: { path: sourceParent, identity: stat(sourceParent) }, basename: "entry", expected: { ...stat(source), kind } },
    destination: { parent: { path: destinationParent, identity: stat(destinationParent) }, basename: "entry" },
    assertBeforeMutation: () => {},
  };
  return { root, sourceParent, destinationParent, source, destination, options, kind };
}
function retain(options: RetainEntryForPublicationOptions) {
  const operation = retainEntryForPublication(options); operations.push(operation); return operation;
}
function loader(overrides: Partial<NativeBinding>) {
  __setNativeLoaderForTest(() => ({ ...native!, ...overrides }));
}
function content(name: string, kind: "file" | "directory" = "directory") {
  return fs.readFileSync(kind === "directory" ? path.join(name, "bytes") : name, "utf8");
}
afterEach(() => {
  // Methods synchronously settle all descriptors, even on injected failures.
  // Settle an admitted but unused owner before removing its task-private root.
  for (const operation of operations.splice(0)) operation.dispose();
  vi.restoreAllMocks(); __resetNativeLoaderForTest(); __resetFsSafeNativeConfigForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("refuses unavailable native support before moving either entry", () => {
  const f = fixture(); configureFsSafeNative({ mode: "off" });
  expect(() => retain(f.options)).toThrow(expect.objectContaining({
    code: posix || process.platform === "win32" ? "helper-unavailable" : "unsupported-platform",
    details: { result: expect.objectContaining({ transition: "not-published", resources: "closed" }) },
  }));
  expect(content(f.source)).toBe("original"); expect(fs.existsSync(f.destination)).toBe(false);
});

// Native CI builds this addon. Windows has its own retained-handle suite.
describe.runIf(posix && Boolean(native))("public retained entry publication / real native objects", () => {
  it.each(["directory", "file"] as const)("publishes an absent %s once; later dispose preserves newer bytes", kind => {
    const f = fixture(kind); const inode = stat(f.source).ino;
    const operation = retain(f.options); const result = operation.publish();
    expect(result).toEqual({ transition: "committed", verification: "verified", resources: "closed", issues: [] });
    expect(stat(f.destination).ino).toBe(inode); expect(fs.existsSync(f.source)).toBe(false);
    fs.writeFileSync(kind === "directory" ? path.join(f.destination, "bytes") : f.destination, "newer");
    expect(operation.dispose()).toBe(result); expect(operation.publish()).toBe(result);
    expect(content(f.destination, kind)).toBe("newer");
    expect(operation.receipt.capability).toMatchObject({ destinationAbsence: "atomic",
      sourceIdentity: "observed-under-caller-exclusive-namespace", parentBinding: "retained-object" });
  });

  it.each(["preexisting", "raced"] as const)("preserves a %s empty directory destination", schedule => {
    const f = fixture(); const sourceInode = stat(f.source).ino;
    if (schedule === "preexisting") fs.mkdirSync(f.destination);
    let targetInode: bigint | undefined = schedule === "preexisting" ? stat(f.destination).ino : undefined;
    loader({ publishRetainedEntryNoReplace: (...args) => {
      if (schedule === "raced") { fs.mkdirSync(f.destination); targetInode = stat(f.destination).ino; }
      return native!.publishRetainedEntryNoReplace!(...args);
    } });
    const result = retain(f.options).publish();
    expect(result.transition).toBe("not-published"); expect(result.issues[0]?.cause).toMatchObject({ code: "EEXIST" });
    expect(stat(f.source).ino).toBe(sourceInode); expect(content(f.source)).toBe("original");
    expect(stat(f.destination).ino).toBe(targetInode); expect(fs.readdirSync(f.destination)).toEqual([]);
  });

  it.each(["file", "symlink"] as const)("preserves a raced destination %s", kind => {
    const f = fixture("file");
    loader({ publishRetainedEntryNoReplace: (...args) => {
      if (kind === "file") fs.writeFileSync(f.destination, "foreign"); else fs.symlinkSync(f.source, f.destination);
      return native!.publishRetainedEntryNoReplace!(...args);
    } });
    const result = retain(f.options).publish();
    expect(result.transition).toBe("not-published"); expect(content(f.source, "file")).toBe("original");
    if (kind === "file") expect(content(f.destination, "file")).toBe("foreign");
    else expect(fs.readlinkSync(f.destination)).toBe(f.source);
  });

  it.each(["before-retain", "before-publish", "native-admission"] as const)("rejects source substitution %s without moving either object", schedule => {
    const f = fixture();
    const swap = () => { fs.renameSync(f.source, `${f.source}.original`); fs.mkdirSync(f.source); fs.writeFileSync(path.join(f.source, "bytes"), "foreign"); };
    if (schedule === "before-retain") {
      swap(); expect(() => retain(f.options)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    } else {
      if (schedule === "native-admission") loader({ publishRetainedEntryNoReplace: (...args) => {
        swap(); return native!.publishRetainedEntryNoReplace!(...args);
      } });
      const operation = retain(f.options); if (schedule === "before-publish") swap();
      expect(operation.publish().transition).toBe("not-published");
    }
    expect(content(f.source)).toBe("foreign"); expect(content(`${f.source}.original`)).toBe("original");
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it.each(["source", "destination"] as const)("rejects observed retained %s parent substitution", side => {
    const f = fixture(); const operation = retain(f.options);
    const parent = side === "source" ? f.sourceParent : f.destinationParent;
    fs.renameSync(parent, `${parent}.original`); fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, "foreign"), "keep");
    expect(operation.publish().transition).toBe("not-published");
    expect(fs.readFileSync(path.join(parent, "foreign"), "utf8")).toBe("keep");
    expect(content(side === "source" ? path.join(`${parent}.original`, "entry") : f.source)).toBe("original");
  });

  it("rejects an alias parent instead of rebasing the supplied physical identity", () => {
    const f = fixture(); const alias = path.join(f.root, "alias"); fs.symlinkSync(f.sourceParent, alias);
    const options = { ...f.options, source: { ...f.options.source, parent: { ...f.options.source.parent, path: alias } } };
    expect(() => retain(options)).toThrow(expect.objectContaining({ code: "path-alias" }));
    expect(content(f.source)).toBe("original"); expect(fs.existsSync(f.destination)).toBe(false);
  });

  it.each(["symlink", "hardlink"] as const)("rejects a source %s", kind => {
    const f = fixture("file");
    if (kind === "symlink") { fs.renameSync(f.source, `${f.source}.original`); fs.symlinkSync(`${f.source}.original`, f.source); }
    else fs.linkSync(f.source, `${f.source}.alias`);
    const options = { ...f.options, source: { ...f.options.source, expected: { ...stat(f.source), kind: "file" as const } } };
    expect(() => retain(options)).toThrow(expect.objectContaining({ code: kind === "symlink" ? "not-file" : "hardlink" }));
    expect(content(f.source, "file")).toBe("original"); expect(fs.existsSync(f.destination)).toBe(false);
  });

  it("rejects unknown identity and an unavailable backend before native mutation", () => {
    const f = fixture(); const mutation = vi.fn(native!.publishRetainedEntryNoReplace!);
    loader({ publishRetainedEntryNoReplace: mutation });
    expect(() => retain({ ...f.options, source: { ...f.options.source, expected: { ...f.options.source.expected, ino: 0n } } }))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    loader({ publishRetainedEntryNoReplace: mutation, entryPublicationFilesystem: () => { throw Object.assign(new Error("unknown filesystem"), { code: "ENOTSUP" }); } });
    expect(() => retain(f.options)).toThrow(); expect(mutation).not.toHaveBeenCalled();
    expect(content(f.source)).toBe("original"); expect(fs.existsSync(f.destination)).toBe(false);
  });

  it("keeps a falsy authority refusal primary through close failure and consumes each fd once", () => {
    const f = fixture(); const closeFault = new Error("close transport failed"); let sourceCloses = 0;
    loader({ closeOwnedFd: fd => { sourceCloses++; native!.closeOwnedFd(fd); throw closeFault; } });
    const operation = retain({ ...f.options, assertBeforeMutation: () => { throw undefined; } });
    const result = operation.publish();
    expect(result).toMatchObject({ transition: "not-published", resources: "close-failed" });
    expect(result.issues).toEqual([{ phase: "authority", cause: undefined }, { phase: "close", cause: closeFault }]);
    expect(operation.dispose()).toBe(result); expect(sourceCloses).toBe(1);
    expect(content(f.source)).toBe("original"); expect(fs.existsSync(f.destination)).toBe(false);
  });

  it("does not admit asynchronous or reentrant authority; callback substitutions are rechecked", () => {
    const f = fixture();
    const asyncResult = retain({ ...f.options, assertBeforeMutation: async () => {} }).publish();
    expect(asyncResult.transition).toBe("not-published"); expect(asyncResult.issues[0]?.cause).toBeInstanceOf(TypeError);
    let operation: RetainedEntryPublication;
    operation = retain({ ...f.options, assertBeforeMutation: () => { operation.dispose(); } });
    expect(operation.publish().transition).toBe("not-published");
    const swapped = retain({ ...f.options, assertBeforeMutation: () => {
      fs.renameSync(f.source, `${f.source}.original`); fs.mkdirSync(f.source);
    } }).publish();
    expect(swapped.transition).toBe("not-published"); expect(content(`${f.source}.original`)).toBe("original");
    expect(fs.readdirSync(f.source)).toEqual([]); expect(fs.existsSync(f.destination)).toBe(false);
  });

  it("records commit before postcheck failure and preserves replacement destination on dispose", () => {
    const f = fixture();
    loader({ publishRetainedEntryNoReplace: (...args) => {
      const result = native!.publishRetainedEntryNoReplace!(...args);
      fs.renameSync(f.destination, `${f.destination}.published`); fs.mkdirSync(f.destination);
      fs.writeFileSync(path.join(f.destination, "bytes"), "newer"); return result;
    } });
    const operation = retain(f.options); const result = operation.publish();
    expect(result).toMatchObject({ transition: "committed", verification: "failed", resources: "closed" });
    expect(result.issues[0]?.phase).toBe("postcheck"); expect(operation.dispose()).toBe(result);
    expect(content(f.destination)).toBe("newer"); expect(content(`${f.destination}.published`)).toBe("original");
  });

  it("keeps committed postcheck failure primary when source and parent closes also report errors", () => {
    const f = fixture(); const sourceClose = new Error("source close"), parentClose = new Error("parent close");
    let closeCalls = 0; const close = fs.closeSync.bind(fs);
    loader({ closeOwnedFd: fd => { native!.closeOwnedFd(fd); throw sourceClose; },
      publishRetainedEntryNoReplace: (...args) => {
        const result = native!.publishRetainedEntryNoReplace!(...args);
        fs.renameSync(f.destination, `${f.destination}.published`); return result;
      } });
    const operation = retain(f.options);
    vi.spyOn(fs, "closeSync").mockImplementation(fd => { close(fd); closeCalls++; throw parentClose; });
    const result = operation.publish(); expect(result.transition).toBe("committed");
    expect(result.resources).toBe("close-failed"); expect(result.issues.map(issue => issue.phase)).toEqual(["postcheck", "close", "close", "close"]);
    expect(result.issues[1]?.cause).toBe(sourceClose); expect(result.issues[2]?.cause).toBe(parentClose);
    expect(operation.dispose()).toBe(result); expect(closeCalls).toBe(2); vi.restoreAllMocks();
    expect(content(`${f.destination}.published`)).toBe("original");
  });

  it.each(["throw-after-commit", "unknown-reply"] as const)("retains indeterminate native transition for %s", fault => {
    const f = fixture(); const lost = new Error("lost reply");
    loader({ publishRetainedEntryNoReplace: (...args) => {
      native!.publishRetainedEntryNoReplace!(...args);
      if (fault === "throw-after-commit") throw lost;
      return { outcome: "unknown" } as never;
    } });
    const operation = retain(f.options); const result = operation.publish();
    expect(result.transition).toBe("indeterminate"); expect(result.verification).toBe("not-performed");
    if (fault === "throw-after-commit") expect(result.issues[0]?.cause).toBe(lost);
    fs.mkdirSync(f.source); fs.writeFileSync(path.join(f.source, "bytes"), "new source occupant");
    expect(operation.dispose()).toBe(result); expect(content(f.destination)).toBe("original");
    expect(content(f.source)).toBe("new source occupant");
  });

  it("dispose before publication only closes; frozen caller inputs cannot redirect the owner", () => {
    const f = fixture(); const operation = retain(f.options);
    expect(Object.isFrozen(operation.receipt.source.expected)).toBe(true);
    const result = operation.dispose(); expect(result.transition).toBe("not-published"); expect(result.resources).toBe("closed");
    expect(operation.publish()).toBe(result); expect(content(f.source)).toBe("original"); expect(fs.existsSync(f.destination)).toBe(false);
  });

  it("a first committed child survives a later child collision without reverse or cleanup", () => {
    const f = fixture("file"); const first = retain(f.options); expect(first.publish().transition).toBe("committed");
    fs.writeFileSync(f.destination, "newer"); fs.writeFileSync(f.source, "second");
    const second = retain({ ...f.options, source: { ...f.options.source, expected: { ...stat(f.source), kind: "file" } } });
    expect(second.publish().transition).toBe("not-published"); first.dispose(); second.dispose();
    expect(content(f.destination, "file")).toBe("newer"); expect(content(f.source, "file")).toBe("second");
  });
  it("admission failure retains its cause and reports failed parent close exactly once", () => {
    const f = fixture(); const fault = new Error("filesystem admission failed"); const closeFault = new Error("parent close failed");
    loader({ entryPublicationFilesystem: () => { throw fault; } });
    const close = fs.closeSync.bind(fs); let closed = 0;
    vi.spyOn(fs, "closeSync").mockImplementation(fd => { close(fd); closed++; throw closeFault; });
    let caught: unknown;
    try { retain(f.options); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ cause: fault, details: { result: {
      transition: "not-published", resources: "close-failed",
      issues: [{ phase: "admission", cause: fault }, { phase: "close", cause: closeFault }, { phase: "close", cause: closeFault }],
    } } });
    expect(closed).toBe(2); vi.restoreAllMocks(); expect(content(f.source)).toBe("original");
  });

  it("commit and successful verification survive a later descriptor close error", () => {
    const f = fixture(); const fault = new Error("close failed after commit");
    loader({ closeOwnedFd: fd => { native!.closeOwnedFd(fd); throw fault; } });
    const operation = retain(f.options); const result = operation.publish();
    expect(result).toMatchObject({ transition: "committed", verification: "verified", resources: "close-failed",
      issues: [{ phase: "close", cause: fault }] });
    expect(content(f.destination)).toBe("original"); expect(operation.dispose()).toBe(result);
  });

  it.runIf(process.platform === "linux" && fs.existsSync("/dev/shm"))("refuses an actual cross-device target before namespace mutation", () => {
    const f = fixture(); const other = fs.realpathSync.native(fs.mkdtempSync("/dev/shm/fs-safe-entry-publication-")); roots.push(other);
    expect(stat(other).dev).not.toBe(stat(f.sourceParent).dev);
    const options = { ...f.options, destination: { parent: { path: other, identity: stat(other) }, basename: "entry" } };
    expect(() => retain(options)).toThrow(expect.objectContaining({ cause: expect.objectContaining({ code: "EXDEV" }) }));
    expect(content(f.source)).toBe("original"); expect(fs.readdirSync(other)).toEqual([]);
  });

  it.each(["directory", "file"] as const)("refuses a case-alias destination of the source %s without changing spelling", kind => {
    const f = fixture(kind); const destination = path.join(f.sourceParent, "ENTRY");
    const aliases = fs.existsSync(destination);
    const operation = retain({ ...f.options, destination: { parent: f.options.source.parent, basename: "ENTRY" } });
    const result = operation.publish();
    if (aliases) {
      expect(result.transition).toBe("not-published");
      expect(fs.readdirSync(f.sourceParent)).toEqual(["entry"]);
      expect(content(f.source, kind)).toBe("original");
    } else {
      expect(result.transition).toBe("committed");
      expect(fs.readdirSync(f.sourceParent)).toEqual(["ENTRY"]);
      expect(content(destination, kind)).toBe("original");
    }
  });

});
