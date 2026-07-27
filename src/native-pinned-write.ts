import { randomUUID } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import {
  removeNativeCreatedFileIfStillPinned,
  syncNativeFileBestEffort,
  writeNativeFd,
} from "./native-operations.js";
import type { NativeBinding } from "./native.js";
import type { PinnedWriteInput, PinnedWriteParams } from "./pinned-write.js";

function assertWithinMaxBytes(bytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`,
    );
  }
}

async function inputToBuffer(
  input: PinnedWriteInput,
  maxBytes: number | undefined,
): Promise<Buffer> {
  if (input.kind === "buffer") {
    const data = typeof input.data === "string"
      ? Buffer.from(input.data, input.encoding ?? "utf8")
      : Buffer.from(input.data);
    assertWithinMaxBytes(data.byteLength, maxBytes);
    return data;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input.stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    assertWithinMaxBytes(bytes, maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function nativeOpenFlags(flags: number): number {
  const closeOnExec = (fsSync.constants as typeof fsSync.constants & { O_CLOEXEC?: number }).O_CLOEXEC;
  return (
    flags |
    (closeOnExec ?? 0) |
    (typeof fsSync.constants.O_NOFOLLOW === "number" ? fsSync.constants.O_NOFOLLOW : 0)
  );
}

function sameNativeIdentity(
  left: Pick<FileIdentityStat, "dev" | "ino">,
  right: Pick<FileIdentityStat, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function runPinnedWriteNative(
  binding: NativeBinding,
  params: PinnedWriteParams,
): Promise<FileIdentityStat> {
  const data = await inputToBuffer(params.input, params.maxBytes);
  const root = await fs.open(
    params.rootPath,
    fsSync.constants.O_RDONLY |
      (typeof fsSync.constants.O_DIRECTORY === "number" ? fsSync.constants.O_DIRECTORY : 0),
  );
  let parentFd: number | undefined;
  let tempFd: number | undefined;
  let targetFd: number | undefined;
  let tempIdentity: Stats | undefined;
  let parentPath = params.rootPath;
  const tempName = `.${params.basename}.${randomUUID()}.native.tmp`;
  let renamed = false;
  try {
    const rootIdentity = binding.fstatIdentity(root.fd);
    if (params.rootIdentity && !sameNativeIdentity(params.rootIdentity, rootIdentity)) {
      throw new FsSafeError("path-mismatch", "root path changed during native write");
    }
    if (params.mkdir) {
      binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
    }
    const parentFlags =
      fsSync.constants.O_RDONLY |
      (typeof fsSync.constants.O_DIRECTORY === "number" ? fsSync.constants.O_DIRECTORY : 0);
    parentFd = binding.openBeneath(root.fd, params.relativeParentPath, parentFlags).fd;
    parentPath = await fs.realpath(
      params.relativeParentPath
        ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
        : params.rootPath,
    );
    const parentPathStat = await fs.lstat(parentPath);
    const parentIdentity = binding.fstatIdentity(parentFd);
    if (
      parentPathStat.isSymbolicLink() ||
      !sameNativeIdentity(parentPathStat, parentIdentity)
    ) {
      throw new FsSafeError("path-mismatch", "native write parent changed during resolution");
    }
    try {
      await fs.lstat(path.join(parentPath, params.basename));
      throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    tempFd = binding.openBeneath(
      parentFd,
      tempName,
      nativeOpenFlags(
        fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
      ),
    ).fd;
    fsSync.fchmodSync(tempFd, params.mode || 0o600);
    writeNativeFd(tempFd, data);
    syncNativeFileBestEffort(tempFd);
    tempIdentity = fsSync.fstatSync(tempFd);
    binding.renameNoReplace(parentFd, tempName, parentFd, params.basename);
    renamed = true;
    targetFd = binding.openBeneath(
      parentFd,
      params.basename,
      nativeOpenFlags(fsSync.constants.O_RDONLY),
    ).fd;
    const targetIdentity = binding.fstatIdentity(targetFd);
    if (!targetIdentity.isFile || !sameNativeIdentity(tempIdentity, targetIdentity)) {
      throw new FsSafeError("path-mismatch", "native write target changed after rename");
    }
    syncNativeFileBestEffort(parentFd);
    return { dev: targetIdentity.dev, ino: targetIdentity.ino };
  } finally {
    if (targetFd !== undefined) {
      fsSync.closeSync(targetFd);
    }
    if (tempFd !== undefined) {
      fsSync.closeSync(tempFd);
    }
    if (!renamed && parentFd !== undefined) {
      removeNativeCreatedFileIfStillPinned({
        binding,
        parentPath,
        parentFd,
        basename: tempName,
        created: tempIdentity,
      });
    }
    if (parentFd !== undefined) {
      fsSync.closeSync(parentFd);
    }
    await root.close().catch(() => undefined);
  }
}
