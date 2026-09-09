import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

export async function observeArchiveFs(directory: string) {
  const probe = await fs.open(path.join(directory, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  await fs.unlink(path.join(directory, "probe"));
  const counts: Record<string, number> = {};
  const syncs: string[] = [];
  const fstat = fsSync.fstatSync;
  const bump = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; };
  const record = (fd: number) => syncs.push(fstat(fd).isFile() ? "file" : "directory");
  const groups = [
    [fsSync, "s", ["fsyncSync", "fdatasyncSync", "copyFileSync", "openSync", "renameSync", "lstatSync", "statSync", "fstatSync"]],
    [fs, "p", ["open", "rename", "copyFile", "mkdir", "readFile", "writeFile", "lstat", "stat", "realpath", "unlink", "rm", "readdir", "link"]],
    [prototype, "h", ["sync", "datasync", "stat", "read", "write", "writeFile", "readFile", "chmod", "close"]],
  ] as const;
  for (const [object, prefix, names] of groups) {
    for (const name of names) {
      const target = object as unknown as Record<string, (...args: unknown[]) => unknown>;
      const original = target[name]!;
      if (typeof original !== "function") continue;
      vi.spyOn(target, name).mockImplementation(function (this: FileHandle, ...args: unknown[]) {
        bump(`${prefix}.${name}`);
        if (["sync", "datasync"].includes(name)) record(this.fd);
        if (["fsyncSync", "fdatasyncSync"].includes(name)) record(args[0] as number);
        return original.apply(this, args);
      });
    }
  }
  const realpath = fsSync.realpathSync.native;
  vi.spyOn(fsSync.realpathSync, "native").mockImplementation((...args: Parameters<typeof realpath>) => {
    bump("s.realpathSync.native");
    return realpath(...args);
  });
  return { counts, syncs, total: () => Object.values(counts).reduce((sum, count) => sum + count, 0) };
}
