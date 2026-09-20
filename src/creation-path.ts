import fs, { type BigIntStats } from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import {
  assertDirectoryIdentitySync,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
  type AnyAsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { CreationPermissions } from "./creation-permissions.js";
import { assertDarwinCreationDirectoryAcl, assertDarwinPrivateDirectoryMode } from "./creation-darwin.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { assertNoNulPathInput } from "./path.js";
import { realpathSync } from "./realpath.js";
import { assertNoWindowsPathAlias, resolvePathPreservingWindowsRoot } from "./windows-path-alias.js";

export type CreationParentIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  realPath?: string;
}>;

export type CreationPath = {
  target: string;
  parent: AsyncDirectoryGuard<BigIntStats>;
  assertParent(): void;
};

export function assertBeforeCreation(
  selected: CreationPath,
  permissions: CreationPermissions,
  assertion: (() => void) | undefined,
  kind: "file" | "directory",
): void {
  if (permissions.private) assertDarwinCreationDirectoryAcl(selected.parent.dir, selected.parent.stat, kind);
  assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
  selected.assertParent();
  if (permissions.private && kind === "directory") assertDarwinPrivateDirectoryMode(permissions.mode!);
  if (permissions.private) assertDarwinCreationDirectoryAcl(selected.parent.dir, selected.parent.stat, kind);
}

export function creationAdmissionFromParent(parent: AnyAsyncDirectoryGuard): { expectedParentIdentity: CreationParentIdentity } {
  const { dev, ino } = parent.stat;
  if (typeof dev !== "bigint" || typeof ino !== "bigint") {
    throw new FsSafeError("path-mismatch", "private creation requires an exact parent identity");
  }
  const identity = inspectDirectoryIdentitySync(parent.dir, { dev, ino });
  return { expectedParentIdentity: { dev: identity.dev, ino: identity.ino, realPath: parent.realPath } };
}

export function prepareCreationPath(input: string, expectedParent?: CreationParentIdentity): CreationPath {
  expectedParent = expectedParent && { dev: expectedParent.dev, ino: expectedParent.ino, realPath: expectedParent.realPath };
  assertNoNulPathInput(input);
  assertNoWindowsPathAlias(input, "filesystem");
  if (process.platform === "win32" && input.replaceAll("/", "\\").split("\\")
    .some(component => component.endsWith(".") || component.endsWith(" "))) {
    throw new FsSafeError("invalid-path", "creation path contains an ambiguous Windows component");
  }
  const target = resolvePathPreservingWindowsRoot(input);
  const directory = path.dirname(target);
  if (target === directory || input.length === 0) {
    throw new FsSafeError("invalid-path", "creation requires a child name");
  }
  if (expectedParent) assertDirectoryIdentitySync(directory, expectedParent);
  const stat = inspectDirectoryIdentitySync(directory);
  const realPath = realpathSync.native(directory);
  const parent = { dir: directory, realPath, stat };
  const assertParent = () => {
    assertDirectoryIdentitySync(directory, { dev: stat.dev, ino: stat.ino, realPath });
    if (expectedParent) assertDirectoryIdentitySync(directory, expectedParent);
  };
  assertParent();
  return { target, parent, assertParent };
}

export function creationCollision(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") {
    return new FsSafeError("already-exists", "creation target already exists", { cause: error });
  }
  return error;
}

/** Remove only the recorded empty stage; never traverse a replaced directory. */
export function removeCreationDirectory(directory: string, identity: BigIntStats, assertParent: () => void): void {
  assertParent();
  try {
    assertDirectoryIdentitySync(directory, identity);
    fs.rmdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}

export async function removeCreationDirectoryAsync(
  directory: string, identity: BigIntStats, assertParent: () => void,
): Promise<void> {
  assertParent();
  try {
    assertDirectoryIdentitySync(directory, identity);
    await fsAsync.rmdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}
