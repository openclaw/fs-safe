import path from "node:path";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type QueueValidationRoot = {
  path: string;
  allowSymlinkBase: boolean;
};

export function resolveQueueFilesystemPath(value: string): string {
  const resolved = resolvePathPreservingWindowsRoot(value);
  assertNoWindowsPathAlias(resolved);
  return resolved;
}

export async function queueValidationRoots(
  queueDir: string,
  failedDir: string,
): Promise<{ queueRoot: QueueValidationRoot; failedRoot: QueueValidationRoot }> {
  const queueRoot = queueValidationRoot(queueDir);
  return {
    queueRoot,
    failedRoot: queueValidationRoot(failedDir),
  };
}

export function queueValidationRoot(dir: string): QueueValidationRoot {
  return {
    path: path.parse(resolveQueueFilesystemPath(dir)).root,
    allowSymlinkBase: process.platform === "darwin",
  };
}
