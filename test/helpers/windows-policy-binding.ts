import fsSync from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import type { NativeBinding } from "../../src/native.js";

// Deterministic dispatch fixture, not a substitute for native containment tests.
// Only fixture-owned paths are used; production still dispatches through native.
export function windowsPolicyBinding(rootPath: string) {
  const paths = new Map<number, string>();
  const opened: number[] = [];
  const directoryOpens: string[] = [];
  const directory = (fd: number) => paths.get(fd) ?? rootPath;
  const actualClose = fsSync.closeSync.bind(fsSync);
  const close = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
    paths.delete(fd);
    actualClose(fd);
  });
  const binding = {
    closeOwnedFd(fd: number) { fsSync.closeSync(fd); },
    openBeneath: vi.fn(function (this: NativeBinding, parentFd: number, relative: string, flags: number) {
      expect(this).toBe(binding);
      const pathname = path.join(directory(parentFd), ...relative.split("/"));
      if (!(flags & fsSync.constants.O_CREAT) && relative !== "value") directoryOpens.push(relative);
      const fd = fsSync.openSync(pathname, flags, 0o600);
      paths.set(fd, pathname);
      opened.push(fd);
      return { fd, containment: "best-effort" as const };
    }),
    mkdirChildBeneath: vi.fn(function (this: NativeBinding, parentFd: number, basename: string, mode: number) {
      expect(this).toBe(binding);
      expect(basename).not.toMatch(/[\\/]/);
      try {
        fsSync.mkdirSync(path.join(directory(parentFd), basename), { mode });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    }),
    mkdirBeneath: vi.fn(function (this: NativeBinding, parentFd: number, relative: string, mode: number) {
      expect(this).toBe(binding);
      fsSync.mkdirSync(path.join(directory(parentFd), ...relative.split("/")), { recursive: true, mode });
    }),
    copyFileExclusive: vi.fn(async function (
      this: NativeBinding, sourceFd: number, parentFd: number, basename: string,
      clone: "never" | "auto" | "always", maxBytes?: number, signal?: AbortSignal,
    ) {
      expect(this).toBe(binding);
      signal?.throwIfAborted();
      if (clone === "always") throw Object.assign(new Error("fixture cannot clone"), { code: "ENOTSUP" });
      const size = fsSync.fstatSync(sourceFd).size;
      if (maxBytes !== undefined && size > maxBytes) throw Object.assign(new Error("too large"), { code: "too-large" });
      const { fd } = binding.openBeneath(parentFd, basename, fsSync.constants.O_RDWR | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL);
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        for (;;) {
          signal?.throwIfAborted();
          const read = fsSync.readSync(sourceFd, buffer, 0, buffer.length, offset);
          if (!read) break;
          if (maxBytes !== undefined && offset + read > maxBytes) throw Object.assign(new Error("too large"), { code: "too-large" });
          let written = 0;
          while (written < read) {
            const count = fsSync.writeSync(fd, buffer, written, read - written, offset + written);
            if (count === 0) throw new Error("fixture copy made no progress");
            written += count;
          }
          offset += read;
        }
        return { fd, method: "copy" as const };
      } catch (error) {
        binding.closeOwnedFd(fd);
        fsSync.unlinkSync(path.join(directory(parentFd), basename));
        throw error;
      }
    }),
    renameReplace(fromFd: number, from: string, toFd: number, to: string) {
      fsSync.renameSync(path.join(directory(fromFd), from), path.join(directory(toFd), to));
    },
    renameNoReplace(fromFd: number, from: string, toFd: number, to: string) {
      const target = path.join(directory(toFd), to);
      if (fsSync.existsSync(target)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      fsSync.renameSync(path.join(directory(fromFd), from), target);
    },
    fstatIdentity(fd: number) {
      const stat = fsSync.fstatSync(fd);
      return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
    },
  };
  return { binding: binding as unknown as NativeBinding, calls: binding, directoryOpens, opened, close, paths };
}
