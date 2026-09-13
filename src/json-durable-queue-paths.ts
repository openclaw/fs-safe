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

function commonPathAncestor(paths: string[]): string {
  const resolved = paths.map(resolveQueueFilesystemPath);
  const root = path.parse(resolved[0] ?? process.cwd()).root;
  const parts = resolved.map((entry) => path.relative(root, entry).split(path.sep));
  const common: string[] = [];
  for (let index = 0; parts.every((part) => index < part.length); index++) {
    const segment = parts[0]?.[index];
    if (!segment || !parts.every((part) => part[index] === segment)) break;
    common.push(segment);
  }
  return path.join(root, ...common);
}

function samePathRoot(paths: string[]): boolean {
  const roots = paths.map((entry) => path.parse(resolveQueueFilesystemPath(entry)).root);
  const first = process.platform === "win32" ? roots[0]?.toLowerCase() : roots[0];
  return roots.every((root) => (process.platform === "win32" ? root.toLowerCase() : root) === first);
}

export async function queueValidationRoots(
  queueDir: string,
  failedDir: string,
): Promise<{ queueRoot: QueueValidationRoot; failedRoot: QueueValidationRoot }> {
  if (samePathRoot([queueDir, failedDir])) {
    const common = commonPathAncestor([queueDir, failedDir]);
    const root = queueValidationRoot(common);
    return { failedRoot: root, queueRoot: root };
  }
  return {
    failedRoot: queueValidationRoot(failedDir),
    queueRoot: queueValidationRoot(queueDir),
  };
}

export function queueValidationRoot(dir: string): QueueValidationRoot {
  return {
    path: path.parse(resolveQueueFilesystemPath(dir)).root,
    allowSymlinkBase: process.platform === "darwin",
  };
}
