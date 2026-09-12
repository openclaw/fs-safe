import { createHash } from "node:crypto";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { inspectFileIdentity } from "./strict-file-identity.js";

export type Sha256FileInput = string | FileHandle;

export type Sha256FileResult = {
  bytes: number;
  digest: string;
};

export async function hashFileHandle(
  handle: FileHandle,
  native: NativeBinding | undefined = getNativeBinding(),
): Promise<Sha256FileResult> {
  const stat = fsSync.fstatSync(handle.fd);
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", "SHA-256 input is not a regular file");
  }
  if (native) {
    return await native.sha256File(handle.fd);
  }

  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(
    Math.min(256 * 1024, Math.max(64 * 1024, stat.size)),
  );
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return { bytes: position, digest: hash.digest("hex") };
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function hashPath(filePath: string): Promise<Sha256FileResult> {
  const before = await inspectFileIdentity(async () => {
    const stat = fsSync.lstatSync(filePath, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new FsSafeError("symlink", "SHA-256 path must not be a symbolic link");
    }
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "SHA-256 path is not a regular file");
    }
    return stat;
  });

  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, resolveReadOpenFlags());
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ELOOP") {
      throw new FsSafeError("symlink", "SHA-256 path must not be a symbolic link", {
        cause: error,
      });
    }
    throw error;
  }

  try {
    const opened = await inspectFileIdentity(async () => {
      const stat = fsSync.fstatSync(handle.fd, { bigint: true });
      if (!stat.isFile()) {
        throw new FsSafeError("not-file", "SHA-256 path is not a regular file");
      }
      return stat;
    }, before);
    await inspectFileIdentity(async () => {
      const stat = fsSync.lstatSync(filePath, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new FsSafeError("path-mismatch", "SHA-256 path changed while opening");
      }
      return stat;
    }, opened);
    return await hashFileHandle(handle);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function sha256File(input: Sha256FileInput): Promise<Sha256FileResult> {
  return typeof input === "string" ? await hashPath(input) : await hashFileHandle(input);
}
