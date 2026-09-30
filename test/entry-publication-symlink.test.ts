import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
try { native = __loadBundledNativeForTest(); } catch { /* Native-off refusal is covered by the base suite. */ }
if (process.env.FS_SAFE_TEST_PUBLICATION_NATIVE === "1" && !native) {
  throw new Error("publication native proof requires the built host binding");
}
const readonlyDirectories: string[] = [];
const roots: string[] = [], operations: RetainedEntryPublication[] = [];
const stat = (name: string) => fs.lstatSync(name, { bigint: true });
function options(source: string, destination: string): RetainEntryForPublicationOptions {
  const sourceParent = path.dirname(source), destinationParent = path.dirname(destination);
  return {
    source: { parent: { path: sourceParent, identity: stat(sourceParent) }, basename: path.basename(source),
      expected: { ...stat(source), kind: "symlink" } },
    destination: { parent: { path: destinationParent, identity: stat(destinationParent) }, basename: path.basename(destination) },
    assertBeforeMutation: () => {},
  };
}
function fixture(target: string | Buffer = "../payload") {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-publication-link-")));
  roots.push(root);
  const staging = path.join(root, "staging"), destinationParent = path.join(root, "destination");
  fs.mkdirSync(staging); fs.mkdirSync(destinationParent);
  const payload = path.join(root, "payload"); fs.writeFileSync(payload, "external read-only bytes", { mode: 0o444 });
  const source = path.join(staging, "entry"), destination = path.join(destinationParent, "entry");
  fs.symlinkSync(target === "absolute" ? payload : target, source);
  return { root, staging, destinationParent, source, destination, payload };
}
function retain(input: RetainEntryForPublicationOptions) {
  const operation = retainEntryForPublication(input); operations.push(operation); return operation;
}
function loader(overrides: Partial<NativeBinding>) { __setNativeLoaderForTest(() => ({ ...native!, ...overrides })); }
const targetBytes = (name: string) => fs.readlinkSync(name, { encoding: "buffer" });
afterEach(() => {
  for (const operation of operations.splice(0)) operation.dispose();
  __resetNativeLoaderForTest();
  for (const directory of readonlyDirectories.splice(0)) fs.chmodSync(directory, 0o755);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf((process.platform === "darwin" || process.platform === "linux") && Boolean(native))(
  "public one-way direct symlink publication / real native objects", () => {
    it.each(["../payload", "absolute", "../missing", "entry", Buffer.from([0x2e, 0x2e, 0x2f, 0xff])])(
      "moves the link inode and exact target bytes without following %s", target => {
        const f = fixture(target), original = stat(f.source), bytes = targetBytes(f.source), payload = stat(f.payload);
        const operation = retain(options(f.source, f.destination));
        const result = operation.publish();
        expect(result).toEqual({ transition: "committed", verification: "verified", resources: "closed", issues: [] });
        expect(stat(f.destination)).toMatchObject({ dev: original.dev, ino: original.ino });
        expect(stat(f.destination).isSymbolicLink()).toBe(true);
        expect(targetBytes(f.destination)).toEqual(bytes);
        expect(() => stat(f.source)).toThrow(expect.objectContaining({ code: "ENOENT" }));
        expect(stat(f.payload)).toMatchObject({ dev: payload.dev, ino: payload.ino, mode: payload.mode, mtimeNs: payload.mtimeNs });
        expect(fs.readFileSync(f.payload, "utf8")).toBe("external read-only bytes");
        // Source reoccupation and a foreign destination replacement are not disposal targets.
        fs.symlinkSync("new-source", f.source); fs.renameSync(f.destination, `${f.destination}.published`);
        fs.symlinkSync("new-destination", f.destination);
        expect(operation.dispose()).toBe(result); expect(operation.publish()).toBe(result);
        expect(targetBytes(`${f.destination}.published`)).toEqual(bytes);
        expect(fs.readlinkSync(f.source)).toBe("new-source"); expect(fs.readlinkSync(f.destination)).toBe("new-destination");
      },
    );

    it.each(["file", "directory", "symlink"] as const)("preserves an occupied %s target and the original link", kind => {
      const f = fixture(), original = stat(f.source);
      const occupy = () => {
        if (kind === "file") fs.writeFileSync(f.destination, "foreign");
        else if (kind === "directory") fs.mkdirSync(f.destination);
        else fs.symlinkSync("missing-foreign", f.destination);
      };
      let foreign: ReturnType<typeof stat>;
      // Inject only scheduling; native no-replace still decides the result.
      loader({ publishRetainedEntryNoReplace: (...args) => { occupy(); foreign = stat(f.destination); return native!.publishRetainedEntryNoReplace!(...args); } });
      const result = retain(options(f.source, f.destination)).publish();
      expect(result).toMatchObject({ transition: "not-published", resources: "closed", verification: "not-performed" });
      expect(result.issues[0]?.cause).toMatchObject({ code: "EEXIST" });
      expect(stat(f.source).ino).toBe(original.ino); expect(fs.readlinkSync(f.source)).toBe("../payload");
      expect(stat(f.destination).ino).toBe(foreign!.ino);
      if (kind === "file") expect(fs.readFileSync(f.destination, "utf8")).toBe("foreign");
      if (kind === "directory") expect(fs.readdirSync(f.destination)).toEqual([]);
      if (kind === "symlink") expect(fs.readlinkSync(f.destination)).toBe("missing-foreign");
    });

    it.each(["before-retain", "before-publish", "native-admission"] as const)("refuses same-target link replacement %s", schedule => {
      const f = fixture(), input = options(f.source, f.destination), original = stat(f.source);
      const swap = () => { fs.renameSync(f.source, `${f.source}.original`); fs.symlinkSync("../payload", f.source); };
      if (schedule === "before-retain") { swap(); expect(() => retain(input)).toThrow(expect.objectContaining({ code: "path-mismatch" })); }
      else {
        if (schedule === "native-admission") loader({ publishRetainedEntryNoReplace: (...args) => { swap(); return native!.publishRetainedEntryNoReplace!(...args); } });
        const operation = retain(input); if (schedule === "before-publish") swap();
        expect(operation.publish().transition).toBe("not-published");
      }
      expect(stat(`${f.source}.original`).ino).toBe(original.ino); expect(stat(f.source).ino).not.toBe(original.ino);
      expect(fs.readlinkSync(f.source)).toBe("../payload"); expect(fs.readlinkSync(`${f.source}.original`)).toBe("../payload");
      expect(() => stat(f.destination)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    });

    it("preserves committed link and newer payload after postcheck and close failures", () => {
      const f = fixture(), fault = new Error("source close failed"); let closes = 0;
      loader({ publishRetainedEntryNoReplace: (...args) => {
        const result = native!.publishRetainedEntryNoReplace!(...args);
        fs.renameSync(f.destination, `${f.destination}.published`); fs.symlinkSync("foreign", f.destination); return result;
      }, closeOwnedFd: fd => { closes++; native!.closeOwnedFd(fd); throw fault; } });
      const operation = retain(options(f.source, f.destination)), result = operation.publish();
      expect(result).toMatchObject({ transition: "committed", verification: "failed", resources: "close-failed" });
      expect(result.issues.map(issue => issue.phase)).toEqual(["postcheck", "close"]); expect(result.issues[1]?.cause).toBe(fault);
      fs.chmodSync(f.payload, 0o644); fs.writeFileSync(f.payload, "newer external bytes");
      expect(operation.dispose()).toBe(result); expect(closes).toBe(1);
      expect(fs.readlinkSync(`${f.destination}.published`)).toBe("../payload"); expect(fs.readlinkSync(f.destination)).toBe("foreign");
      expect(fs.readFileSync(f.payload, "utf8")).toBe("newer external bytes");
    });

    it("keeps a lost native reply indeterminate without inverse or disposal deletion", () => {
      const f = fixture(), lost = new Error("lost reply");
      loader({ publishRetainedEntryNoReplace: (...args) => { native!.publishRetainedEntryNoReplace!(...args); throw lost; } });
      const operation = retain(options(f.source, f.destination)), result = operation.publish();
      expect(result).toMatchObject({ transition: "indeterminate", verification: "not-performed", resources: "closed", issues: [{ phase: "native", cause: lost }] });
      fs.symlinkSync("foreign", f.source); expect(operation.dispose()).toBe(result);
      expect(fs.readlinkSync(f.source)).toBe("foreign"); expect(fs.readlinkSync(f.destination)).toBe("../payload");
    });

    it("closes an unpublished link without touching either name or its target", () => {
      const f = fixture(), operation = retain(options(f.source, f.destination));
      const result = operation.dispose(); expect(result).toEqual({ transition: "not-published", verification: "not-performed", resources: "closed", issues: [] });
      expect(operation.publish()).toBe(result); expect(fs.readlinkSync(f.source)).toBe("../payload");
      expect(() => stat(f.destination)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    });

    it("rejects hardlinked symlink entries before effect", () => {
      const f = fixture();
      // Node linkSync follows the source on Darwin; ln -P links the entry itself.
      execFileSync("ln", ["-P", f.source, `${f.source}.alias`]);
      expect(stat(f.source).nlink).toBe(2n);
      expect(() => retain(options(f.source, f.destination))).toThrow(expect.objectContaining({ code: "hardlink" }));
      expect(stat(f.source).nlink).toBe(2n); expect(fs.readlinkSync(f.source)).toBe("../payload");
      expect(() => stat(f.destination)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    });

    it("does not admit a case-alias source or rename over its own case-alias destination", () => {
      const f = fixture(), input = options(f.source, f.destination), alias = path.join(f.staging, "ENTRY");
      const aliases = fs.readdirSync(f.staging).includes("entry") && (() => { try { return stat(alias).ino === stat(f.source).ino; } catch { return false; } })();
      const aliasInput = { ...input, source: { ...input.source, basename: "ENTRY" } };
      expect(() => retain(aliasInput)).toThrow(aliases ? expect.objectContaining({ code: "path-alias" }) : undefined);
      const operation = retain({ ...input, destination: { parent: input.source.parent, basename: "ENTRY" } });
      expect(operation.publish().transition).toBe(aliases ? "not-published" : "committed");
      expect(fs.readdirSync(f.staging)).toEqual([aliases ? "entry" : "ENTRY"]);
      expect(fs.readlinkSync(aliases ? f.source : alias)).toBe("../payload");
    });

    it("preserves an empty target inode while moving runtime/tracked links before .git", () => {
      const f = fixture("payload"), rootInode = stat(f.destinationParent).ino;
      fs.unlinkSync(f.payload); fs.mkdirSync(f.payload);
      fs.writeFileSync(path.join(f.payload, "bytes"), "external", { mode: 0o444 });
      fs.chmodSync(f.payload, 0o555); readonlyDirectories.push(f.payload);
      const external = stat(f.payload);
      // The owned runtime store is a sibling of the existing checkout, not removed
      // or collapsed into that checkout. Its external payload remains read-only.
      const siblingStore = path.join(f.root, "runtime-store");
      const tracked = path.join(f.staging, "tracked"), trackedTarget = path.join(f.destinationParent, "tracked");
      fs.symlinkSync("../payload", tracked); fs.mkdirSync(path.join(f.staging, ".git"));
      const store = retain(options(f.source, siblingStore)), trackedOperation = retain(options(tracked, trackedTarget));
      expect(store.publish().transition).toBe("committed"); expect(trackedOperation.publish().transition).toBe("committed");
      const gitSource = path.join(f.staging, ".git"), gitDestination = path.join(f.destinationParent, ".git");
      const gitOptions = options(gitSource, gitDestination);
      const git = retain({ ...gitOptions, source: { ...gitOptions.source, expected: { ...stat(gitSource), kind: "directory" } } });
      expect(git.publish().transition).toBe("committed");
      expect(stat(f.destinationParent).ino).toBe(rootInode); expect(fs.readlinkSync(trackedTarget)).toBe("../payload");
      expect(fs.readdirSync(f.staging)).toEqual([]); expect(fs.readdirSync(f.destinationParent).sort()).toEqual([".git", "tracked"]);
      // A later resource collision never reverses any previous publication.
      fs.symlinkSync("remaining", f.source);
      expect(retain(options(f.source, siblingStore)).publish().transition).toBe("not-published");
      store.dispose(); trackedOperation.dispose(); git.dispose();
      expect(fs.readlinkSync(f.source)).toBe("remaining"); expect(fs.readlinkSync(siblingStore)).toBe("payload");
      expect(stat(f.payload)).toMatchObject({ ino: external.ino, mode: external.mode, mtimeNs: external.mtimeNs });
      expect(fs.readFileSync(path.join(siblingStore, "bytes"), "utf8")).toBe("external");
      expect(stat(f.destinationParent).ino).toBe(rootInode);
    });
  },
);
