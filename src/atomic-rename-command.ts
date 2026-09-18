import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { assertSyncDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import type { RootContext } from "./root-context.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";

export type AtomicRenameOutcome = "not-attempted" | "committed" | "unknown";
type Identity = Pick<BigIntStats, "dev" | "ino">;
type Parent = {
  parentPath: string;
  parentRelativePath: string;
  parentIdentity: Identity;
  basename: string;
};
export type RootMoveCommandInput = {
  root: { path: string; identity: RootContext["rootIdentity"] };
  source: Parent & { identity: Identity };
  target: Parent;
};
type Guard = AsyncDirectoryGuard<BigIntStats>;

function changed(message: string): never {
  throw new FsSafeError("path-mismatch", message);
}

function assertCommandAllowed(): void {
  if (getFsSafeNativeConfig().mode === "require") {
    throw new FsSafeError("helper-unavailable", "atomic rename command fallback is disabled by native require mode");
  }
}

function assertRegular(stat: BigIntStats, links: bigint): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== links) {
    changed("atomic rename source type or link count changed");
  }
}

function inspectParent(fd: number, parent: Guard): void {
  const stat = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), parent.stat);
  if (!stat.isDirectory()) changed("atomic rename parent descriptor changed");
}

function openParent(parent: Guard): number {
  const route = nodeDirectorySearchOnlyFlags();
  if (!route) throw new FsSafeError("helper-unavailable", "atomic rename search-only parent descriptors are unavailable");
  const fd = fs.openSync(parent.realPath, route.flags | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    inspectParent(fd, parent);
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch (closeError) {
      throw createSuppressedError(closeError, error, "atomic rename parent admission and close failed");
    }
    throw error;
  }
}

export async function renameNoReplaceWithCommand(params: {
  source: { path: string; parent: Guard; identity: BigIntStats; fd?: number };
  target: { path: string; parent: Guard };
  root: RootMoveCommandInput["root"];
  assertCurrent: () => void;
  assertBeforeMutation?: () => void;
  onOutcome?: (outcome: AtomicRenameOutcome) => void;
}): Promise<void> {
  // Load only the chosen bridge, before the final synchronous authority fence.
  const command = process.platform === "linux" ? await import("./linux-rename-command.js")
    : process.platform === "darwin" ? await import("./darwin-move-command.js")
      : process.platform === "win32" ? await import("./windows-move-command.js") : undefined;
  if (!command) throw new FsSafeError("helper-unavailable", "atomic no-replace rename commands are unavailable on this platform");
  assertCommandAllowed();
  warnNativeFallback("Root.move no-replace", "A system command performs the atomic rename. Command startup adds overhead; final pathname checks cannot eliminate concurrent name-swap races.");
  const identity = { dev: params.source.identity.dev, ino: params.source.identity.ino };
  const links = params.source.identity.nlink;
  const parents = [...new Set([params.source.parent, params.target.parent])];
  const descriptors = new Map<Guard, number>();
  let outcome: AtomicRenameOutcome = "not-attempted";
  const setOutcome = (next: AtomicRenameOutcome) => { outcome = next; params.onOutcome?.(next); };
  const settledError = (error: unknown) => {
    if (outcome === "not-attempted") return error;
    const details = { ...(error instanceof FsSafeError ? error.details : {}) };
    delete details.sourceConsumed;
    return new FsSafeError(
      error instanceof FsSafeError ? error.code : "helper-failed",
      outcome === "committed" ? "atomic rename committed but verification or cleanup failed" : "atomic rename outcome is unknown",
      { cause: error, details: { ...details, commit: outcome,
        ...(outcome === "committed" ? { sourceConsumed: true } : {}) } },
    );
  };
  const assertParents = () => {
    for (const parent of parents) assertSyncDirectoryGuard(parent);
    for (const [parent, fd] of descriptors) inspectParent(fd, parent);
  };
  const assertSource = () => {
    assertRegular(inspectFileIdentitySync(() => fs.lstatSync(params.source.path, { bigint: true }), identity), links);
    if (params.source.fd !== undefined) {
      assertRegular(inspectFileIdentitySync(() => fs.fstatSync(params.source.fd!, { bigint: true }), identity), links);
    }
  };
  const assertPublished = () => {
    assertRegular(inspectFileIdentitySync(() => fs.lstatSync(params.target.path, { bigint: true }), identity), links);
    if (params.source.fd !== undefined) {
      assertRegular(inspectFileIdentitySync(() => fs.fstatSync(params.source.fd!, { bigint: true }), identity), links);
    }
    try {
      fs.lstatSync(params.source.path);
      changed("atomic rename source name still exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  };
  const commandParent = (parent: Guard, filePath: string): Parent => ({
    parentPath: parent.realPath,
    parentRelativePath: path.relative(params.root.path, parent.realPath),
    parentIdentity: { dev: parent.stat.dev, ino: parent.stat.ino },
    basename: path.basename(filePath),
  });
  let failed = false;
  let operationError: unknown;
  try {
    params.assertCurrent();
    assertParents();
    if (process.platform !== "win32") {
      for (const parent of parents) descriptors.set(parent, openParent(parent));
    }
    assertParents();
    assertSource();
    const source = { ...commandParent(params.source.parent, params.source.path), identity };
    const target = commandParent(params.target.parent, params.target.path);
    params.assertBeforeMutation?.();
    params.assertCurrent();
    assertParents();
    assertSource();
    assertCommandAllowed();
    setOutcome("unknown");
    try {
      if ("renameLinuxNoReplaceSync" in command) {
        command.renameLinuxNoReplaceSync({
          source: { ...source, parentFd: descriptors.get(params.source.parent)!, links, fd: params.source.fd },
          target: { ...target, parentFd: descriptors.get(params.target.parent)! },
        });
      } else if ("renameDarwinNoReplace" in command) {
        command.renameDarwinNoReplace({
          source: { ...source, parentFd: descriptors.get(params.source.parent)! },
          target: { ...target, parentFd: descriptors.get(params.target.parent)! },
        });
      } else {
        command.moveWindowsMetadataNoReplaceSync({ root: params.root, source, target });
      }
    } catch (error) {
      // Interpret receipts only from the adapter invocation, never from hooks.
      const commandError = error as { phase?: unknown; commit?: unknown } | undefined;
      const receipt = error instanceof FsSafeError ? error.details?.commit
        : commandError?.phase === "admission" && commandError.commit === "not-attempted" ? "not-attempted" : undefined;
      if (receipt === "committed" || receipt === "not-attempted") setOutcome(receipt);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        throw new FsSafeError("already-exists", "destination exists", { cause: error });
      }
      throw error;
    }
    setOutcome("committed");
    assertParents();
    assertPublished();
  } catch (error) { failed = true; operationError = error; }
  const closeErrors: unknown[] = [];
  for (const fd of new Set(descriptors.values())) {
    try { fs.closeSync(fd); } catch (error) { closeErrors.push(error); }
  }
  if (closeErrors.length) {
    const closeError = closeErrors.length === 1 ? closeErrors[0] : new AggregateError(closeErrors, "atomic rename parent closes failed");
    throw settledError(failed ? createSuppressedError(closeError, operationError, "atomic rename and descriptor close failed") : closeError);
  }
  if (failed) throw settledError(operationError);
  try {
    for (const parent of parents) assertSyncDirectoryGuard(parent);
    assertPublished();
  } catch (error) { throw settledError(error); }
}
