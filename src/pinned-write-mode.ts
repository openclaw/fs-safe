import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";

export function assertPinnedWriteMode(fd: number, mode: number): void {
  if (process.platform === "win32") return;
  if (Number(fs.fstatSync(fd, { bigint: true }).mode & 0o7777n) !== mode) {
    throw new FsSafeError("insecure-permissions", "filesystem did not enforce the secret file mode");
  }
}

export async function preparePinnedWriteMode(
  handle: FileHandle,
  createdMode: number,
  assertBeforeMutation?: () => void,
): Promise<(() => void) | undefined> {
  if (process.platform === "win32") return assertBeforeMutation;
  assertSynchronousCallbackResult(assertBeforeMutation?.(), "assertBeforeMutation");
  if (createdMode !== 0o600) await handle.chmod(0o600);
  return pinnedWriteModeAssertion(handle.fd, 0o600, assertBeforeMutation);
}

export function pinnedWriteModeAssertion(
  fd: number,
  mode: number,
  assertBeforeMutation?: () => void,
): () => void {
  return () => {
    assertSynchronousCallbackResult(assertBeforeMutation?.(), "assertBeforeMutation");
    assertPinnedWriteMode(fd, mode);
  };
}
