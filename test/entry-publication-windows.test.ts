import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RetainEntryForPublicationOptions, RetainedEntryPublication } from "../src/advanced.js";
import type { NativeBinding } from "../src/native.js";
const compiled = process.env.FS_SAFE_TEST_PUBLIC_ARTIFACT === "1";
const { retainEntryForPublication } = compiled ? await import("../dist/advanced.js") : await import("../src/advanced.js");
const { __loadBundledNativeForTest, __setNativeLoaderForTest, __resetNativeLoaderForTest } = compiled
  ? await import("../dist/native.js") : await import("../src/native.js");
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* JS-only lanes prove refusal in the base suite. */ }
if (process.platform === "win32" && process.env.FS_SAFE_TEST_PUBLICATION_NATIVE === "1" && !native) {
  throw new Error("Windows publication proof requires the actual native addon");
}
const roots: string[] = [], operations: RetainedEntryPublication[] = [];
const kinds = ["file", "directory", "file-relative", "file-absolute", "dir-relative", "dir-absolute", "junction"] as const;
type Kind = typeof kinds[number];
function stat(name: string) { return fs.lstatSync(name, { bigint: true }); }
function fixture(kind: Kind = "junction") {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-windows-publication-"))); roots.push(root);
  const staging = path.join(root, "staging"), target = path.join(root, "checkout"), payload = path.join(root, "payload");
  fs.mkdirSync(staging); fs.mkdirSync(target);
  const source = path.join(staging, "entry"), destination = path.join(target, "entry");
  if (kind === "file" || kind.startsWith("file-")) fs.writeFileSync(payload, "external");
  else { fs.mkdirSync(payload); fs.writeFileSync(path.join(payload, "bytes"), "external"); }
  if (kind === "file") fs.writeFileSync(source, "original");
  else if (kind === "directory") { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "bytes"), "original"); }
  else fs.symlinkSync(kind.endsWith("relative") ? "..\\payload" : payload, source,
    kind === "junction" ? "junction" : kind.startsWith("file-") ? "file" : "dir");
  return { root, staging, target, source, destination, payload, kind };
}
function options(source: string, destination: string): RetainEntryForPublicationOptions {
  const observed = stat(source);
  return { source: { parent: { path: path.dirname(source), identity: stat(path.dirname(source)) }, basename: path.basename(source),
    expected: { ...observed, kind: observed.isSymbolicLink() ? "symlink" : observed.isDirectory() ? "directory" : "file" } },
  destination: { parent: { path: path.dirname(destination), identity: stat(path.dirname(destination)) }, basename: path.basename(destination) },
  assertBeforeMutation: () => {} };
}
function retain(input: RetainEntryForPublicationOptions) { const op = retainEntryForPublication(input); operations.push(op); return op; }
// Fault wrappers only perturb scheduling/transport AFTER calling real native methods.
// Never manufacture a successful admission, rename or close.
type Owner = ReturnType<NonNullable<NativeBinding["retainWindowsEntryPublication"]>>;
function wrap(transform: (owner: Owner) => Owner) {
  __setNativeLoaderForTest(() => ({ ...native!,
    retainWindowsEntryPublication: (...args) => transform(native!.retainWindowsEntryPublication!(...args)),
  }));
}
function facade(owner: Owner, overrides: Partial<Owner>): Owner {
  return { admission: owner.admission, current: p => owner.current(p), publish: () => owner.publish(), close: () => owner.close(), ...overrides };
}
afterEach(() => {
  for (const op of operations.splice(0)) op.dispose();
  __resetNativeLoaderForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe.runIf(process.platform === "win32" && Boolean(native))("native Windows retained publication", () => {
  it.each(kinds)("publishes %s exactly once without changing entry identity or target bytes", kind => {
    const f = fixture(kind), before = stat(f.source), payload = stat(f.payload), input = options(f.source, f.destination);
    const bytes = before.isSymbolicLink() ? fs.readlinkSync(f.source, { encoding: "buffer" }) : undefined;
    const op = retain(input), result = op.publish();
    expect(result).toEqual({ transition: "committed", verification: "verified", resources: "closed", issues: [] });
    expect(stat(f.destination)).toMatchObject({ dev: before.dev, ino: before.ino });
    expect(() => stat(f.source)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    if (bytes) expect(fs.readlinkSync(f.destination, { encoding: "buffer" })).toEqual(bytes);
    else expect(fs.readFileSync(kind === "directory" ? path.join(f.destination, "bytes") : f.destination, "utf8")).toBe("original");
    expect(stat(f.payload)).toMatchObject({ ino: payload.ino, mtimeNs: payload.mtimeNs });
    expect(fs.readFileSync(kind === "file" || kind.startsWith("file-") ? f.payload : path.join(f.payload, "bytes"), "utf8")).toBe("external");
    expect(op.receipt.capability).toMatchObject({ destinationAbsence: "atomic", sourceFilesystem: "ntfs", destinationFilesystem: "ntfs" });
    expect(op.dispose()).toBe(result); expect(op.publish()).toBe(result);
  });

  it.each(["file", "directory", "junction"] as const)("preserves a raced %s destination and original junction", kind => {
    const f = fixture(), original = stat(f.source); let occupied: ReturnType<typeof stat>;
    wrap(owner => facade(owner, { publish: () => {
      if (kind === "file") fs.writeFileSync(f.destination, "foreign");
      else if (kind === "directory") fs.mkdirSync(f.destination);
      else fs.symlinkSync(f.payload, f.destination, "junction");
      occupied = stat(f.destination); return owner.publish();
    } }));
    const result = retain(options(f.source, f.destination)).publish();
    expect(result).toMatchObject({ transition: "not-published", resources: "closed" });
    expect(result.issues[0]?.cause).toMatchObject({ code: "EEXIST" });
    expect(stat(f.source).ino).toBe(original.ino); expect(stat(f.destination).ino).toBe(occupied!.ino);
    if (kind === "file") expect(fs.readFileSync(f.destination, "utf8")).toBe("foreign");
    if (kind === "directory") expect(fs.readdirSync(f.destination)).toEqual([]);
    if (kind === "junction") expect(fs.readlinkSync(f.destination)).toBe(fs.readlinkSync(f.source));
  });

  it.each(["before-retain", "authority", "dispatch"] as const)("refuses a replaced same-target junction at %s", schedule => {
    const f = fixture(), input = options(f.source, f.destination), original = stat(f.source);
    const swap = () => { fs.renameSync(f.source, `${f.source}.original`); fs.symlinkSync(f.payload, f.source, "junction"); };
    if (schedule === "before-retain") { swap(); expect(() => retain(input)).toThrow(); }
    else {
      if (schedule === "dispatch") wrap(owner => facade(owner, { publish: () => { swap(); return owner.publish(); } }));
      const op = retain({ ...input, assertBeforeMutation: schedule === "authority" ? swap : input.assertBeforeMutation });
      expect(op.publish().transition).toBe("not-published");
    }
    expect(stat(`${f.source}.original`).ino).toBe(original.ino); expect(stat(f.source).ino).not.toBe(original.ino);
    expect(fs.readlinkSync(f.source)).toBe(fs.readlinkSync(`${f.source}.original`));
    expect(() => stat(f.destination)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it.each(["source", "destination", "ancestor"] as const)("refuses observed %s parent substitution", side => {
    const f = fixture(), input = options(f.source, f.destination), op = retain(input);
    const parent = side === "source" ? f.staging : side === "destination" ? f.target : f.root;
    try { fs.renameSync(parent, `${parent}.original`); }
    catch (error) {
      // Windows may fence an ancestor rename while descendants are open, even
      // with delete sharing. Prove that exclusion and its release; do not skip.
      expect(["EPERM", "EACCES", "EBUSY"]).toContain((error as NodeJS.ErrnoException).code);
      expect(stat(f.source).ino).toBe(input.source.expected.ino);
      expect(stat(f.staging).ino).toBe(input.source.parent.identity.ino);
      expect(stat(f.target).ino).toBe(input.destination.parent.identity.ino);
      expect(op.dispose()).toEqual({ transition: "not-published", verification: "not-performed", resources: "closed", issues: [] });
      fs.renameSync(parent, `${parent}.original`); // same attempt must work after close
      if (side === "ancestor") roots.push(`${parent}.original`);
      const location = side === "source" ? path.join(`${parent}.original`, "entry") : side === "ancestor" ? path.join(`${parent}.original`, "staging", "entry") : f.source;
      expect(stat(location).ino).toBe(input.source.expected.ino);
      return;
    }
    if (side === "ancestor") { roots.push(`${parent}.original`); fs.mkdirSync(parent); }
    else fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, "foreign"), "keep");
    expect(op.publish().transition).toBe("not-published");
    expect(fs.readFileSync(path.join(parent, "foreign"), "utf8")).toBe("keep");
    const originalSource = side === "source" ? path.join(`${parent}.original`, "entry") : side === "ancestor" ? path.join(`${parent}.original`, "staging", "entry") : f.source;
    expect(stat(originalSource).ino).toBe(input.source.expected.ino);
  });

  it.each(["postcheck", "verified"] as const)("keeps commit through %s and close transport failures", postcheck => {
    const f = fixture(), original = stat(f.source); let closed = 0;
    wrap(owner => facade(owner, { publish: () => {
      const result = owner.publish();
      if (postcheck === "postcheck") { fs.renameSync(f.destination, `${f.destination}.published`); fs.writeFileSync(f.destination, "newer"); }
      return result;
    }, close: () => { closed++; owner.close(); throw new Error("close reply lost"); } }));
    const op = retain(options(f.source, f.destination)), result = op.publish();
    expect(result).toMatchObject({ transition: "committed", verification: postcheck === "postcheck" ? "failed" : "verified", resources: "close-failed" });
    expect(result.issues.map(x => x.phase)).toEqual(postcheck === "postcheck" ? ["postcheck", "close"] : ["close"]);
    expect(stat(postcheck === "postcheck" ? `${f.destination}.published` : f.destination).ino).toBe(original.ino);
    if (postcheck === "postcheck") expect(fs.readFileSync(f.destination, "utf8")).toBe("newer");
    expect(op.dispose()).toBe(result); expect(closed).toBe(1);
  });

  it.each(["lost", "malformed"] as const)("retains indeterminate disposition for a %s native reply", failure => {
    const f = fixture(), original = stat(f.source);
    wrap(owner => facade(owner, { publish: () => { owner.publish(); if (failure === "lost") throw new Error("reply lost"); return { outcome: "unknown" } as never; } }));
    const op = retain(options(f.source, f.destination)), result = op.publish();
    expect(result).toMatchObject({ transition: "indeterminate", verification: "not-performed", resources: "closed" });
    expect(stat(f.destination).ino).toBe(original.ino);
    fs.writeFileSync(f.source, "new occupant"); expect(op.dispose()).toBe(result);
    expect(fs.readFileSync(f.source, "utf8")).toBe("new occupant");
  });

  it("disposes only handles and retains falsy authority failure before all close diagnostics", () => {
    const f = fixture(), input = options(f.source, f.destination);
    const closed = retain(input).dispose(); expect(closed).toEqual({ transition: "not-published", verification: "not-performed", resources: "closed", issues: [] });
    wrap(owner => facade(owner, { close: () => { owner.close(); return [{ code: "EIO", message: "first close" }, { code: "EIO", message: "second close" }]; } }));
    const result = retain({ ...input, assertBeforeMutation: () => { throw undefined; } }).publish();
    expect(result.resources).toBe("close-failed"); expect(result.issues.map(x => x.phase)).toEqual(["authority", "close", "close"]);
    expect(result.issues[0]?.cause).toBeUndefined(); expect(stat(f.source).ino).toBe(input.source.expected.ino);
    expect(() => stat(f.destination)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("rejects hardlinks, parent junction aliases and case-only source/destination aliases", () => {
    const f = fixture("file"); fs.linkSync(f.source, `${f.source}.alias`);
    expect(() => retain(options(f.source, f.destination))).toThrow(expect.objectContaining({ code: "hardlink" }));
    fs.unlinkSync(`${f.source}.alias`);
    const alias = path.join(f.root, "alias"); fs.symlinkSync(f.staging, alias, "junction");
    const input = options(f.source, f.destination);
    expect(() => retain({ ...input, source: { ...input.source, parent: { ...input.source.parent, path: alias } } })).toThrow();
    expect(() => retain({ ...input, source: { ...input.source, basename: "ENTRY" } })).toThrow();
    const result = retain({ ...input, destination: { parent: input.source.parent, basename: "ENTRY" } }).publish();
    expect(result.transition).toBe("not-published"); expect(fs.readdirSync(f.staging)).toEqual(["entry"]);
    expect(fs.readFileSync(f.source, "utf8")).toBe("original");
  });

  it("preserves original-empty checkout and sibling runtime junction stores across later collision", () => {
    const f = fixture(), checkout = stat(f.target), store = path.join(f.root, "runtime-store");
    const storeOp = retain(options(f.source, store)); expect(storeOp.publish().transition).toBe("committed");
    fs.symlinkSync(f.payload, f.source, "junction");
    expect(retain(options(f.source, f.destination)).publish().transition).toBe("committed");
    fs.mkdirSync(path.join(f.staging, ".git"));
    expect(retain(options(path.join(f.staging, ".git"), path.join(f.target, ".git"))).publish().transition).toBe("committed");
    fs.symlinkSync(f.payload, f.source, "junction");
    expect(retain(options(f.source, store)).publish().transition).toBe("not-published");
    expect(stat(f.target).ino).toBe(checkout.ino); expect(fs.readdirSync(f.target).sort()).toEqual([".git", "entry"]);
    expect(fs.readlinkSync(store)).toBe(fs.readlinkSync(f.source)); expect(fs.readFileSync(path.join(store, "bytes"), "utf8")).toBe("external");
    storeOp.dispose(); expect(stat(f.target).ino).toBe(checkout.ino);
  });
});
