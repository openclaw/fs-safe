import fsSync from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { NativeBinding } from "../../src/native.js";

export function noReplaceAdapter(rootPath: string, onRename?: () => void, onOpen?: (relativePath: string) => void) {
  const directoryPaths = new Map<number, string>();
  const openBeneath = vi.fn((
    _rootFd: number,
    relativePath: string,
    flags: number,
  ) => {
    onOpen?.(relativePath);
    const directoryPath = relativePath
      ? path.join(rootPath, ...relativePath.split("/"))
      : rootPath;
    const fd = fsSync.openSync(directoryPath, flags);
    directoryPaths.set(fd, directoryPath);
    return { fd, containment: "best-effort" as const };
  });
  const renameNoReplace = vi.fn((
    sourceParentFd: number,
    sourceName: string,
    targetParentFd: number,
    targetName: string,
  ) => {
    onRename?.();
    const sourceParent = directoryPaths.get(sourceParentFd);
    const targetParent = directoryPaths.get(targetParentFd);
    if (!sourceParent || !targetParent) throw new Error("unadmitted test directory");
    const source = path.join(sourceParent, sourceName);
    const target = path.join(targetParent, targetName);
    try {
      fsSync.lstatSync(target);
      throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsSync.renameSync(source, target);
  });
  const binding = { openBeneath, renameNoReplace, closeOwnedFd: (fd: number) => fsSync.closeSync(fd) } as unknown as NativeBinding;
  return { binding, openBeneath, renameNoReplace };
}
