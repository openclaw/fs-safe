import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { assertPrivateCreationFile } from "./creation-boundary.js";

export function assertPinnedWriteMode(fd: number, mode: number, privateCreation = false): void {
  if (process.platform === "win32") return;
  const stat = fs.fstatSync(fd, { bigint: true });
  if (privateCreation) assertPrivateCreationFile(stat, fd);
  if (Number(stat.mode & 0o7777n) !== mode) {
    throw new FsSafeError("insecure-permissions", "filesystem did not enforce the requested file mode");
  }
}

export async function preparePinnedWriteMode(
  handle: FileHandle,
  createdMode: number,
  assertBeforeMutation?: () => void,
  privateCreation = false,
): Promise<(() => void) | undefined> {
  if (process.platform === "win32") return assertBeforeMutation;
  assertSynchronousCallbackResult(assertBeforeMutation?.(), "assertBeforeMutation");
  if (createdMode !== 0o600) {
    if (privateCreation) assertPrivateCreationFile(fs.fstatSync(handle.fd, { bigint: true }), handle.fd);
    await handle.chmod(0o600);
  }
  return pinnedWriteModeAssertion(handle.fd, 0o600, assertBeforeMutation, privateCreation);
}

export function pinnedWriteModeAssertion(
  fd: number,
  mode: number,
  assertBeforeMutation?: () => void,
  privateCreation = false,
): () => void {
  return () => {
    assertSynchronousCallbackResult(assertBeforeMutation?.(), "assertBeforeMutation");
    assertPinnedWriteMode(fd, mode, privateCreation);
  };
}
