import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { vi } from "vitest";

export const readIdentity = { dev: 9007199254740992n, ino: 9007199254740992n };
export type ReadBoundary = "preview" | "descriptor" | "current";
type Sample = (Partial<typeof readIdentity> & { kind?: "symlink" | "directory"; nlink?: bigint }) | Error;
export type ReadSamples = Partial<Record<ReadBoundary, Sample[]>>;

// Model exact filesystem identities over real I/O, projecting to Number only
// when the caller requests numeric Stats. Windows cases are not kernel proof.
export function observeReadAdmission(filePath: string, options: {
  samples?: ReadSamples;
  swap?: "before-open" | "after-open";
  numericAdapter?: ReadBoundary;
} = {}) {
  let opened = false;
  let swapped = false;
  const counts = { preview: 0, descriptor: 0, current: 0 };
  const open = vi.fn();
  const read = vi.fn();
  const close = vi.fn();
  const handles: fs.FileHandle[] = [];
  const descriptors = new Set<number>();
  const displaced = `${filePath}.displaced`;
  const replacement = `${filePath}.replacement`;
  const rename = fsSync.renameSync.bind(fsSync);
  function swap() {
    rename(filePath, displaced);
    rename(replacement, filePath);
    swapped = true;
  }
  function observe(boundary: ReadBoundary, stat: Stats | BigIntStats, bigint: boolean) {
    const sequence = options.samples?.[boundary];
    const attempt = bigint ? counts[boundary]++ : 0;
    const sample = sequence?.[Math.min(attempt, sequence.length - 1)] ?? {};
    if (sample instanceof Error) throw sample;
    const replaced = boundary === "current" ? swapped
      : boundary === "descriptor" && options.swap === "before-open";
    const identity = { ...readIdentity, ino: readIdentity.ino + (replaced ? 1n : 0n), ...sample };
    for (const field of ["dev", "ino"] as const) {
      stat[field] = bigint && options.numericAdapter !== boundary ? identity[field] : Number(identity[field]);
    }
    if (sample.kind) {
      stat.isSymbolicLink = () => sample.kind === "symlink";
      stat.isFile = () => false;
      stat.isDirectory = () => sample.kind === "directory";
    }
    if (sample.nlink !== undefined) stat.nlink = bigint ? sample.nlink : Number(sample.nlink);
    return stat;
  }
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    return String(args[0]) === filePath
      ? observe(opened ? "current" : "preview", stat, args[1]?.bigint === true) : stat;
  });
  const lstatSync = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstatSync(...args);
    return String(args[0]) === filePath
      ? observe(opened ? "current" : "preview", stat, args[1]?.bigint === true) : stat;
  });
  const actualOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) !== filePath) return await actualOpen(...args);
    if (options.swap === "before-open") swap();
    const handle = await actualOpen(...args);
    opened = true;
    open();
    handles.push(handle);
    if (options.swap === "after-open") swap();
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (options) =>
      observe("descriptor", await stat(options), options?.bigint === true));
    for (const method of ["read", "readFile"] as const) {
      const actual = handle[method].bind(handle);
      vi.spyOn(handle, method).mockImplementation((...args: never[]) => {
        read();
        return actual(...args);
      });
    }
    const actualClose = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      close();
      await actualClose();
    });
    return handle;
  });
  const openSync = fsSync.openSync.bind(fsSync);
  vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
    if (String(args[0]) !== filePath) return openSync(...args);
    if (options.swap === "before-open") swap();
    const fd = openSync(...args);
    opened = true;
    open();
    descriptors.add(fd);
    if (options.swap === "after-open") swap();
    return fd;
  });
  const fstat = fsSync.fstatSync.bind(fsSync);
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    const stat = fstat(...args);
    return descriptors.has(args[0]) ? observe("descriptor", stat, args[1]?.bigint === true) : stat;
  });
  const readFile = fsSync.readFileSync.bind(fsSync);
  vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => {
    if (typeof args[0] === "number" && descriptors.has(args[0])) read();
    return readFile(...args);
  });
  const actualClose = fsSync.closeSync.bind(fsSync);
  vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    if (descriptors.has(fd)) { close(); descriptors.delete(fd); }
    actualClose(fd);
  });
  return { counts, open, read, close, handles, displaced, replacement };
}
