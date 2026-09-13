import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStoreSync } from "../src/store.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

const cases: readonly { name: string; opaque: boolean; replacement?: string; reopenFails?: boolean }[] = [
  { name: "rounded inode replacement", opaque: false, replacement: "substitute" },
  { name: "opaque replacement", opaque: true, replacement: "substitute" },
  { name: "opaque same-byte replacement", opaque: true, replacement: "payload" },
  { name: "unchanged opaque path", opaque: true, replacement: undefined },
  { name: "opaque path that cannot be verified", opaque: true, reopenFails: true },
];

function projected<T extends Stats | BigIntStats>(stat: T, ino: bigint, opaque = false): T {
  const dev = opaque ? 0n : 17n;
  const inode = opaque ? 0n : ino;
  return Object.assign(Object.create(stat), {
    dev: typeof stat.dev === "bigint" ? dev : Number(dev),
    ino: typeof stat.ino === "bigint" ? inode : Number(inode),
  });
}

describe.each([false, true])("sync store exact publication identity (private=%s)", privateMode => {
  it.each(cases)("handles $name without accepting a different file", async ({ opaque, replacement, reopenFails }) => {
    const directory = await tempRoot("fs-safe-sync-store-exact-");
    const target = path.join(directory, "target");
    const published = path.join(directory, "published");
    const sourceInode = 9007199254740992n;
    expect(Number(sourceInode)).toBe(Number(sourceInode + 1n));
    Object.defineProperty(process, "platform", { value: "win32" });
    const fstat = fsSync.fstatSync.bind(fsSync);
    const lstat = fsSync.lstatSync.bind(fsSync);
    const rename = fsSync.renameSync.bind(fsSync);
    const open = fsSync.openSync.bind(fsSync);
    const verificationError = Object.assign(new Error("verification open denied"), { code: "EACCES" });
    let actualSourceInode: bigint | undefined;
    let publicationReached = false;
    // Only file identities are projected; all writes, renames, handles, and directory guards are real.
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      const stat = fstat(...args);
      if (!stat.isFile()) return stat;
      const exact = fstat(args[0], { bigint: true });
      actualSourceInode ??= exact.ino;
      return projected(stat, exact.ino === actualSourceInode ? sourceInode : sourceInode + 1n);
    });
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (!stat.isFile()) return stat;
      const exact = lstat(args[0], { bigint: true });
      return projected(stat, exact.ino === actualSourceInode ? sourceInode : sourceInode + 1n,
        opaque && publicationReached && args[0] === target);
    });
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to !== target) return;
      if (replacement !== undefined) {
        rename(target, published);
        fsSync.writeFileSync(target, replacement);
      }
      publicationReached = true;
    });
    vi.spyOn(fsSync, "openSync").mockImplementation((filePath, flags, mode) => {
      if (reopenFails && publicationReached && filePath === target) throw verificationError;
      return open(filePath, flags, mode);
    });
    const readFile = vi.spyOn(fsSync, "readFileSync");
    const read = vi.spyOn(fsSync, "readSync");
    const write = () => fileStoreSync({ rootDir: directory, private: privateMode, durable: false })
      .write("target", "payload");
    if (reopenFails) expect(write).toThrow(expect.objectContaining({ code: "path-mismatch", cause: verificationError }));
    else if (replacement === undefined) expect(write()).toBe(target);
    else expect(write).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(publicationReached).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await fs.readFile(target, "utf8")).toBe(replacement ?? "payload");
    if (replacement !== undefined) expect(await fs.readFile(published, "utf8")).toBe("payload");
  });

  it.each([0o000, 0o200])("retains its write-only descriptor through publication with mode %s", async mode => {
    const directory = await tempRoot("fs-safe-sync-store-retained-");
    const target = path.join(directory, "target");
    const open = fsSync.openSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const rename = fsSync.renameSync.bind(fsSync);
    let descriptor: number | undefined;
    let retainedAtPublication = false;
    vi.spyOn(fsSync, "openSync").mockImplementation((filePath, flags, fileMode) => {
      const fd = open(filePath, flags, fileMode);
      if (String(filePath).endsWith(".tmp")) {
        expect(flags).toBe("wx");
        descriptor = fd;
      }
      return fd;
    });
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to === target) {
        try { retainedAtPublication = fstat(descriptor!).isFile(); }
        catch { retainedAtPublication = false; }
      }
    });
    const readFile = vi.spyOn(fsSync, "readFileSync");
    const read = vi.spyOn(fsSync, "readSync");
    expect(fileStoreSync({ rootDir: directory, private: privateMode, durable: false, mode })
      .write("target", "payload")).toBe(target);
    expect(retainedAtPublication).toBe(true);
    expect(() => fstat(descriptor!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(readFile).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(mode);
    await fs.chmod(target, 0o600);
    expect(await fs.readFile(target, "utf8")).toBe("payload");
  });
});
