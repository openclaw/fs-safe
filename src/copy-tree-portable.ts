import { setMaxListeners } from "node:events";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native-binding.js";
import {
  assertStagedDirectoryCurrent,
  exactIdentityMatches,
  openStagedDirectory,
} from "./staged-directory.js";

/** Byte-copy adapter for the shared immutable-source, caller-owned namespace contract. */
export async function copyOwnedTree(
  source: ReturnType<typeof openStagedDirectory>,
  destination: string,
  options: {
    signal?: AbortSignal;
    concurrency: number;
    copyFileContents?: NativeBinding["copyFileContents"];
  },
): Promise<void> {
  options.signal?.throwIfAborted();
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  setMaxListeners(options.concurrency, signal);
  const abort = () => cancellation.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const pending = new Set<Promise<void>>();
  const buffers: Buffer[] = [];
  const settle = async () => {
    await Promise.all(pending);
  };
  async function schedule(operation: () => Promise<void>): Promise<void> {
    signal.throwIfAborted();
    const task = operation()
      .catch((error: unknown) => {
        cancellation.abort(error);
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
    if (pending.size >= options.concurrency) await Promise.race(pending);
    signal.throwIfAborted();
  }
  async function copyFile(from: string, to: string, stat: fs.BigIntStats): Promise<void> {
    const input = await fsp.open(
      from,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let output: FileHandle | undefined;
    try {
      const opened = await input.stat({ bigint: true });
      if (!opened.isFile() || !exactIdentityMatches(stat, opened)) {
        throw new FsSafeError("path-mismatch", "copy source changed while opening");
      }
      output = await fsp.open(to, "wx", 0o600);
      if (options.copyFileContents) {
        // napi-rs owns onabort. Each admitted file gets a separate signal so
        // concurrent native copies cannot replace one another's cancellation.
        const fileCancellation = new AbortController();
        const abortFile = () => fileCancellation.abort();
        signal.addEventListener("abort", abortFile, { once: true });
        try {
          signal.throwIfAborted();
          await options.copyFileContents(input.fd, output.fd, fileCancellation.signal);
        } finally {
          signal.removeEventListener("abort", abortFile);
        }
      } else {
        const buffer =
          buffers.pop() ??
          Buffer.allocUnsafe(process.platform === "win32" ? 1024 * 1024 : 128 * 1024);
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
        } finally {
          buffers.push(buffer);
        }
      }
      signal.throwIfAborted();
      if (process.platform !== "win32") await output.chmod(Number(stat.mode & 0o7777n));
      await output.utimes(stat.atime, stat.mtime);
    } catch (error) {
      cancellation.abort(error);
      throw error;
    } finally {
      try {
        await output?.close();
      } finally {
        await input.close();
      }
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
          await schedule(() => copyFile(childSource, childTarget, child));
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
      await settle();
      signal.throwIfAborted();
      assertStagedDirectoryCurrent(original.receipt);
      assertStagedDirectoryCurrent(target.receipt);
      if (process.platform !== "win32") fs.fchmodSync(target.fd, Number(stat.mode & 0o7777n));
      await fsp.utimes(to, stat.atime, stat.mtime);
      assertStagedDirectoryCurrent(target.receipt);
    } catch (error) {
      cancellation.abort(error);
      throw error;
    } finally {
      // Directory descriptors and destination ownership outlive every admitted
      // write, including when traversal, a sibling copy, or cancellation fails.
      await settle();
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
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
