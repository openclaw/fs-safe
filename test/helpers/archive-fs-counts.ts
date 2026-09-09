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
    [fs, "p", Object.keys(fs)],
    [prototype, "h", ["appendFile", "chmod", "chown", "datasync", "read", "readFile", "readv", "stat", "sync", "truncate", "utimes", "write", "writeFile", "writev"]],
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
        const result = original.apply(this, args);
        if (prefix === "p" && name === "open") {
          return (result as Promise<FileHandle>).then((handle) => {
            // FileHandle.close is an own property, not a prototype method.
            const close = handle.close.bind(handle);
            vi.spyOn(handle, "close").mockImplementation(() => {
              bump("h.close");
              return close();
            });
            return handle;
          });
        }
        return result;
      });
    }
  }
  const realpath = fsSync.realpathSync.native;
  vi.spyOn(fsSync.realpathSync, "native").mockImplementation((...args: Parameters<typeof realpath>) => {
    bump("s.realpathSync.native");
    return realpath(...args);
  });
  return {
    counts, syncs,
    total: () => Object.values(counts).reduce((sum, count) => sum + count, 0),
    asyncTotal: () => Object.entries(counts)
      .filter(([name]) => name.startsWith("p.") || name.startsWith("h."))
      .reduce((sum, [, count]) => sum + count, 0),
  };
}
