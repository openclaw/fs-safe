import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync, type ReplaceFileAtomicDestinationState } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const original = "complete original bytes";
const errno = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
type Fault = "stat" | "lstat" | "persistent-lstat" | "swapped-lstat" | "revoked" | "changed" | "restore-write" | "descriptor-changed" | "hardlinked" | "persistent-stat";

// The hunt's adapter harness: real I/O, retained handle wrappers, and one
// operation failure after a successful destination truncate.
async function exercise(synchronous: boolean, fault: Fault) {
  const directory = await tempRoot("fs-safe-restore-metadata-");
  const filePath = path.join(directory, "target");
  const movedPath = path.join(directory, "original");
  fs.writeFileSync(filePath, original, { mode: 0o600 });
  const identity = fs.statSync(filePath, { bigint: true });
  const descriptors = new Set<number>();
  const receipts: ReplaceFileAtomicDestinationState[] = [];
  const failure = errno("EIO"), refusal = new Error("authority revoked");
  let truncated = false, hit = false, writes = 0, revoked = false;
  const afterTruncate = () => { truncated = true; };
  const metadata = (operation: "stat" | "lstat") => {
    if (!truncated || operation !== (fault === "stat" || fault === "persistent-stat" ? "stat" : "lstat")) return;
    if (hit && fault !== "persistent-lstat" && fault !== "persistent-stat") return;
    hit = true;
    if (fault === "swapped-lstat" || fault === "changed") {
      fs.renameSync(filePath, movedPath);
      fs.writeFileSync(filePath, "successor");
    }
    if (fault === "revoked") revoked = true;
    if (fault !== "changed") throw failure;
  };
  const descriptor = (stat: fs.Stats | fs.BigIntStats) => {
    if (!hit || (fault !== "descriptor-changed" && fault !== "hardlinked")) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
      fault === "descriptor-changed" ? { ino: identity.ino + 1n } : { nlink: 2n });
  };
  const beforeWrite = () => {
    writes++;
    if (fault === "restore-write" && hit) throw errno("ENOSPC");
  };
  const sync = {
    ...fs,
    renameSync() { throw errno("EPERM"); },
    openSync: ((candidate, flags, mode) => {
      const fd = fs.openSync(candidate, flags, mode);
      if (String(candidate) === filePath) descriptors.add(fd);
      return fd;
    }) as typeof fs.openSync,
    fstatSync: ((fd, options) => {
      if (descriptors.has(fd)) metadata("stat");
      const stat = fs.fstatSync(fd, options);
      return descriptors.has(fd) ? descriptor(stat) : stat;
    }) as typeof fs.fstatSync,
    lstatSync: ((candidate, options) => {
      if (String(candidate) === filePath) metadata("lstat");
      return fs.lstatSync(candidate, options);
    }) as typeof fs.lstatSync,
    ftruncateSync(fd: number, length?: number) {
      fs.ftruncateSync(fd, length);
      if (descriptors.has(fd)) afterTruncate();
    },
    writeSync: ((fd, buffer, offset, length, position) => {
      if (descriptors.has(fd)) beforeWrite();
      return fs.writeSync(fd, buffer, offset, Math.min(3, length), position);
    }) as typeof fs.writeSync,
    closeSync(fd: number) { descriptors.delete(fd); fs.closeSync(fd); },
  };
  const async = {
    ...fsp,
    async rename() { throw errno("EPERM"); },
    lstat: (async (candidate, options) => {
      if (String(candidate) === filePath) metadata("lstat");
      return await fsp.lstat(candidate, options);
    }) as typeof fsp.lstat,
    open: (async (...args) => {
      const handle = await fsp.open(...args);
      if (String(args[0]) !== filePath) return handle;
      descriptors.add(handle.fd);
      for (const key of ["stat", "truncate", "write", "close"] as const) {
        const method = handle[key].bind(handle) as (...args: any[]) => Promise<any>;
        (handle[key] as unknown) = async (...params: any[]) => {
          if (key === "stat") metadata("stat");
          if (key === "write") { beforeWrite(); params[2] = Math.min(3, params[2]); }
          if (key === "close") descriptors.delete(handle.fd);
          const result = await method(...params);
          if (key === "truncate") afterTruncate();
          return key === "stat" ? descriptor(result) : result;
        };
      }
      return handle;
    }) as typeof fsp.open,
  };
  const options = {
    filePath, content: "replacement bytes", mode: 0o644,
    copyFallbackOnPermissionError: true, copyFallbackRestore: "restore-original" as const,
    maxRestoreBytes: 128, destinationHardlinks: "reject" as const,
    assertBeforeMutation: () => { if (revoked) throw refusal; },
    onDestinationState: (receipt: ReplaceFileAtomicDestinationState) => { receipts.push(receipt); },
  };
  let error: unknown;
  try {
    if (synchronous) replaceFileAtomicSync({ ...options, fileSystem: sync });
    else await replaceFileAtomic({ ...options, fileSystem: { promises: async } });
  } catch (caught) { error = caught; }
  expect(hit).toBe(true);
  expect(descriptors.size).toBe(0);
  expect(receipts).toEqual([{ state: "writing", path: filePath, dev: identity.dev, ino: identity.ino }]);
  expect(Object.isFrozen(receipts[0])).toBe(true);
  expect(fs.readdirSync(directory).sort()).toEqual(fault === "swapped-lstat" || fault === "changed" ? ["original", "target"] : ["target"]);
  return { error, failure, refusal, writes, filePath, movedPath, identity };
}

for (const synchronous of [false, true]) {
  it.each(["stat", "lstat", "persistent-lstat", "swapped-lstat"] as const)(
    `restores the retained original after post-truncate %s EIO (sync=${synchronous})`, async fault => {
      const result = await exercise(synchronous, fault);
      expect(result.error).toMatchObject({ code: "helper-failed", details: { cleanup: "restored" }, cause: result.failure });
      const restoredPath = fault === "swapped-lstat" ? result.movedPath : result.filePath;
      expect(fs.readFileSync(restoredPath, "utf8")).toBe(original);
      const restored = fs.statSync(restoredPath, { bigint: true });
      expect([restored.dev, restored.ino]).toEqual([result.identity.dev, result.identity.ino]);
      if (process.platform !== "win32") expect(restored.mode & 0o777n).toBe(result.identity.mode & 0o777n);
      expect(result.writes).toBeGreaterThan(1);
      if (fault === "swapped-lstat") expect(fs.readFileSync(result.filePath, "utf8")).toBe("successor");
    },
  );

  it(`keeps authority revocation terminal after metadata EIO (sync=${synchronous})`, async () => {
    const result = await exercise(synchronous, "revoked");
    expect(result.error).toBe(result.refusal);
    expect(result.writes).toBe(0);
    expect(fs.readFileSync(result.filePath, "utf8")).toBe("");
  });

  it(`keeps a detected pathname replacement terminal (sync=${synchronous})`, async () => {
    const result = await exercise(synchronous, "changed");
    expect(result.error).toMatchObject({ code: "path-mismatch" });
    expect(result.writes).toBe(0);
    expect(fs.readFileSync(result.filePath, "utf8")).toBe("successor");
    expect(fs.readFileSync(result.movedPath, "utf8")).toBe("");
  });

  it.each(["descriptor-changed", "hardlinked", "persistent-stat"] as const)(
    `refuses restoration when the descriptor cannot be revalidated: %s (sync=${synchronous})`, async fault => {
      const result = await exercise(synchronous, fault);
      expect(result.error).toMatchObject({ code: fault === "descriptor-changed" ? "path-mismatch" : fault === "hardlinked" ? "hardlink" : "EIO" });
      expect(result.writes).toBe(0);
      expect(fs.readFileSync(result.filePath, "utf8")).toBe("");
    },
  );

  it(`reports a failed restoration without claiming publication (sync=${synchronous})`, async () => {
    const result = await exercise(synchronous, "restore-write");
    expect(result.error).toMatchObject({ code: "helper-failed", details: { cleanup: "restore-failed" },
      cause: { errors: [result.failure, expect.objectContaining({ code: "ENOSPC" })] } });
    expect(fs.readFileSync(result.filePath, "utf8")).toBe("");
  });
}
