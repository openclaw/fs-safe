import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFallbackReplace, copyFallbackReplaceSync } from "../src/replace-file-copy-fallback.js";
import { readOwnedCopySourceSync } from "../src/replace-file-copy-source.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture(original: Buffer) {
  const dir = await tempRoot("fs-safe-restore-reads-");
  const source = path.join(dir, "source"), dest = path.join(dir, "dest");
  await fs.writeFile(source, "replacement", { mode: 0o600 });
  await fs.writeFile(dest, original, { mode: 0o600 });
  return { source, dest };
}

function instrument(dest: string, options: {
  shortRead?: number;
  sizeHint?: number;
  beforeFirstRead?: () => void;
  failWrite?: boolean;
} = {}) {
  const reads: Array<{ position: number; requested: number; read: number }> = [];
  let writes = 0;
  const destinations = new Set<number>();
  const statHint = (stat: fsSync.Stats) => options.sizeHint === undefined ? stat
    : Object.assign(Object.create(stat), { size: options.sizeHint });
  const beforeRead = () => { if (reads.length === 0) options.beforeFirstRead?.(); };
  const beforeWrite = () => {
    if (++writes === 1 && options.failWrite) throw new Error("injected replacement write failure");
  };
  const syncModule = {
    ...fsSync,
    openSync: ((name, flags, mode) => {
      const fd = fsSync.openSync(name, flags, mode);
      if (String(name) === dest) destinations.add(fd);
      return fd;
    }) as typeof fsSync.openSync,
    closeSync(fd: number) { destinations.delete(fd); fsSync.closeSync(fd); },
    fstatSync: ((fd, statOptions) => {
      const stat = fsSync.fstatSync(fd, statOptions);
      return destinations.has(fd) && !statOptions?.bigint ? statHint(stat as fsSync.Stats) : stat;
    }) as typeof fsSync.fstatSync,
    readSync: ((fd, buffer, offset, length, position) => {
      if (!destinations.has(fd)) return fsSync.readSync(fd, buffer, offset, length, position);
      beforeRead();
      const read = fsSync.readSync(fd, buffer, offset, Math.min(length, options.shortRead ?? length), position);
      reads.push({ position: position!, requested: length, read });
      return read;
    }) as typeof fsSync.readSync,
    writeSync: ((fd, buffer, offset, length, position) => {
      if (destinations.has(fd)) beforeWrite();
      return fsSync.writeSync(fd, buffer, offset, length, position);
    }) as typeof fsSync.writeSync,
  };
  const asyncModule = {
    ...fs,
    async open(name: fsSync.PathLike, flags: string | number, mode?: fsSync.Mode) {
      const handle = await fs.open(name, flags, mode);
      if (String(name) !== dest) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "stat") return async () => statHint(await target.stat());
          if (property === "read") return async (buffer: Buffer, offset: number, length: number, position: number) => {
            beforeRead();
            const result = await target.read(buffer, offset, Math.min(length, options.shortRead ?? length), position);
            reads.push({ position, requested: length, read: result.bytesRead });
            return result;
          };
          if (property === "write") return async (...args: Parameters<FileHandle["write"]>) => {
            beforeWrite();
            return await target.write(...args);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  return { reads, get writes() { return writes; }, syncModule, asyncModule };
}

async function replace(sync: boolean, files: Awaited<ReturnType<typeof fixture>>, maxRestoreBytes: number,
  adapter: ReturnType<typeof instrument>) {
  const options = { src: files.source, dest: files.dest, restore: "restore-original" as const, maxRestoreBytes, sync: false };
  if (sync) copyFallbackReplaceSync({ ...options, fsModule: adapter.syncModule });
  else await copyFallbackReplace({ ...options, fsModule: adapter.asyncModule });
}

describe.each([false, true])("copy fallback restore reads (sync: %s)", sync => {
  it.each([0, 128, 1024 * 1024, 17 * 1024 * 1024])("restores all %s original bytes after a failed write", async size => {
    const original = Buffer.alloc(size, 0xa5);
    const files = await fixture(original);
    const adapter = instrument(files.dest, { failWrite: true });
    await expect(replace(sync, files, size, adapter)).rejects.toMatchObject({
      code: "helper-failed", details: { cleanup: "restored" },
    });
    expect((await fs.readFile(files.dest)).equals(original)).toBe(true);
    expect(adapter.reads.length).toBeLessThanOrEqual(size > 16 * 1024 * 1024 ? 3 : 2);
    expect(adapter.reads.every((r, i) => r.position === adapter.reads.slice(0, i).reduce((n, r) => n + r.read, 0))).toBe(true);
    expect(adapter.reads[0]!.requested).toBeLessThanOrEqual(16 * 1024 * 1024 + 1);
  }, process.platform === "win32" ? 30_000 : 5_000);

  it.each([0, 90001, Number.MAX_SAFE_INTEGER])("reads through short chunks and EOF with size hint %s", async sizeHint => {
    const original = Buffer.alloc(90001, 0x5a);
    const files = await fixture(original);
    const adapter = instrument(files.dest, { sizeHint, shortRead: 1024, failWrite: true });
    await expect(replace(sync, files, original.length, adapter)).rejects.toMatchObject({ details: { cleanup: "restored" } });
    expect((await fs.readFile(files.dest)).equals(original)).toBe(true);
    expect(adapter.reads.at(-1)?.read).toBe(0);
  });

  it.each([false, true])("checks growth before mutation (over budget: %s)", async overBudget => {
    const files = await fixture(Buffer.from("ab"));
    const adapter = instrument(files.dest, {
      beforeFirstRead: () => fsSync.appendFileSync(files.dest, "cdef"),
      failWrite: !overBudget,
    });
    await expect(replace(sync, files, overBudget ? 4 : 6, adapter)).rejects.toMatchObject(overBudget
      ? { code: "too-large", message: "Atomic replace restore snapshot exceeds maxRestoreBytes (4)" }
      : { code: "helper-failed", details: { cleanup: "restored" } });
    expect(await fs.readFile(files.dest, "utf8")).toBe("abcdef");
    if (overBudget) {
      expect(adapter.writes).toBe(0);
      expect(adapter.reads.reduce((n, r) => n + r.read, 0)).toBe(5);
    }
  });

  it("rejects a nonempty destination with a zero budget before mutation", async () => {
    const files = await fixture(Buffer.from("original"));
    const adapter = instrument(files.dest);
    await expect(replace(sync, files, 0, adapter)).rejects.toMatchObject({ code: "too-large" });
    expect(await fs.readFile(files.dest, "utf8")).toBe("original");
    expect(adapter.writes).toBe(0);
    expect(adapter.reads.map(r => r.read)).toEqual([1]);
  });
});

it("bounds speculative source allocation and returns only initialized bytes", async () => {
  const { source } = await fixture(Buffer.alloc(0));
  const module = {
    ...fsSync,
    fstatSync: ((fd, options) => Object.assign(Object.create(fsSync.fstatSync(fd, options)), {
      size: options?.bigint ? BigInt(Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER,
    })) as typeof fsSync.fstatSync,
  };
  const allocate = Buffer.allocUnsafe;
  let largest = 0;
  vi.spyOn(Buffer, "allocUnsafe").mockImplementation(size => {
    largest = Math.max(largest, size);
    if (size > 16 * 1024 * 1024 + 1) throw new Error("unbounded size hint");
    return allocate(size);
  });
  const result = readOwnedCopySourceSync({ fsModule: module, src: source });
  expect(result.replacement.toString()).toBe("replacement");
  expect(largest).toBeLessThanOrEqual(16 * 1024 * 1024 + 1);
  expect(result.replacement.buffer.byteLength).toBeLessThan(16 * 1024 * 1024);
});
