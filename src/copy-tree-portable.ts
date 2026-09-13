import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import {
  assertStagedDirectoryCurrent,
  exactIdentityMatches,
  openStagedDirectory,
} from "./staged-directory.js";

/** Byte-copy adapter for the shared immutable-source, caller-owned namespace contract. */
export async function copyOwnedTree(
  source: ReturnType<typeof openStagedDirectory>,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const buffer = Buffer.allocUnsafe(128 * 1024);
  async function copyFile(from: string, to: string, stat: fs.BigIntStats): Promise<void> {
    const input = await fsp.open(
      from,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const opened = await input.stat({ bigint: true });
      if (!opened.isFile() || !exactIdentityMatches(stat, opened)) {
        throw new FsSafeError("path-mismatch", "copy source changed while opening");
      }
      const output = await fsp.open(to, "wx", 0o600);
      try {
        let position = 0;
        while (true) {
          signal?.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            signal?.throwIfAborted();
            const { bytesWritten } = await output.write(
              buffer,
              written,
              bytesRead - written,
              position + written,
            );
            if (bytesWritten === 0) throw new Error("copy write made no progress");
            written += bytesWritten;
          }
          position += bytesRead;
        }
        if (process.platform !== "win32") await output.chmod(Number(stat.mode & 0o7777n));
        await output.utimes(stat.atime, stat.mtime);
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  }
  async function copyDirectory(from: string, to: string): Promise<void> {
    signal?.throwIfAborted();
    const stat = await fsp.lstat(from, { bigint: true });
    // Exclusive admission prevents merging a pre-existing directory, including
    // any destination left by an unsuccessful native clone.
    await fsp.mkdir(to, { mode: 0o700 });
    const target = openStagedDirectory(to);
    let original: ReturnType<typeof openStagedDirectory> | undefined;
    try {
      original = openStagedDirectory(from);
      if (!exactIdentityMatches(stat, original.receipt.identity)) {
        throw new FsSafeError("path-mismatch", "copy source directory changed while opening");
      }
      for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
        signal?.throwIfAborted();
        assertStagedDirectoryCurrent(target.receipt);
        assertStagedDirectoryCurrent(original.receipt);
        const childSource = path.join(from, entry.name);
        const childTarget = path.join(to, entry.name);
        const child = await fsp.lstat(childSource, { bigint: true });
        if (child.isDirectory()) {
          await copyDirectory(childSource, childTarget);
        } else if (child.isFile()) {
          await copyFile(childSource, childTarget, child);
        } else if (child.isSymbolicLink()) {
          const link =
            process.platform === "win32"
              ? await fsp.readlink(childSource)
              : await fsp.readlink(childSource, { encoding: "buffer" });
          let type: "dir" | "file" | undefined;
          if (process.platform === "win32") {
            // Older Node releases infer link type from the destination, where a
            // relative directory target may not exist yet. Inspect the source.
            // lstat does not expose the Windows link's directory attribute, so
            // an unresolved source cannot be recreated with a proven type.
            try {
              type = (await fsp.stat(childSource)).isDirectory() ? "dir" : "file";
            } catch (error) {
              if (
                error instanceof Error &&
                "code" in error &&
                (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
              ) {
                throw new FsSafeError(
                  "unsupported-platform",
                  "byte copying cannot determine the type of an unresolved Windows symbolic link",
                  { cause: error },
                );
              }
              throw error;
            }
          }
          signal?.throwIfAborted();
          await fsp.symlink(link, childTarget, type);
        } else {
          throw new FsSafeError("not-file", "tree copying does not support special files");
        }
      }
      assertStagedDirectoryCurrent(original.receipt);
      assertStagedDirectoryCurrent(target.receipt);
      if (process.platform !== "win32") fs.fchmodSync(target.fd, Number(stat.mode & 0o7777n));
      await fsp.utimes(to, stat.atime, stat.mtime);
      assertStagedDirectoryCurrent(target.receipt);
    } finally {
      try {
        if (original) fs.closeSync(original.fd);
      } finally {
        fs.closeSync(target.fd);
      }
    }
  }
  try {
    await copyDirectory(source.receipt.realPath, destination);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}
