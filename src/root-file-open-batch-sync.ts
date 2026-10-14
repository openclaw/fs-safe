import fs from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { openExactNativeRootSync } from "./native-parent-admission.js";
import { isExpectedPathError } from "./pinned-open.js";
import { realpathSync } from "./realpath.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { observeCanonicalRoot, type CanonicalRootObservation } from "./root-file-final-admission.js";
import { openRootFileSync, openRootFileWithRetainedRootSync, type OpenRootFileSyncParams, type RootFileOpenResult } from "./root-file.js";
import { hasWindowsPathAlias } from "./windows-path-alias.js";

export type RootFileOpenBatchSync = {
  openFile(params: OpenRootFileSyncParams): RootFileOpenResult;
  close(): void;
  [Symbol.dispose](): void;
};

type RetainedRoot = {
  owner: ReturnType<typeof openExactNativeRootSync>;
  observation: Extract<CanonicalRootObservation, { ok: true }>;
};
const WINDOWS_ERROR_REPARSE_POINT_ENCOUNTERED = 4395;

function canRetainRoot(params: OpenRootFileSyncParams): boolean {
  return process.platform === "win32" && typeof params.rootPath === "string" &&
    typeof params.absolutePath === "string" && params.ioFs === undefined &&
    params.rootRealPath === undefined && !params.skipLexicalRootCheck &&
    (params.symlinks === "reject" || (params.symlinks === undefined && params.rejectSymlinks !== false)) &&
    /^[a-z]:\\/iu.test(params.rootPath) &&
    !hasWindowsPathAlias(params.rootPath, "filesystem") &&
    !hasWindowsPathAlias(params.absolutePath, "filesystem") &&
    !params.absolutePath.slice(3).split("\\").some(segment => /[. ]$/u.test(segment) || segment.includes("~")) &&
    !params.rootPath.includes("\0") && !params.absolutePath.includes("\0") &&
    path.resolve(params.rootPath) === params.rootPath && path.resolve(params.absolutePath) === params.absolutePath &&
    params.absolutePath.startsWith(params.rootPath.endsWith(path.sep) ? params.rootPath : `${params.rootPath}${path.sep}`);
}

function failure(error: unknown): RootFileOpenResult {
  return { ok: false, reason: error instanceof FsSafeError ? "validation" : isExpectedPathError(error) ? "path" : "io", error };
}

/** Reuses native Windows root handles; other reads keep their one-shot admission. */
export function createRootFileOpenBatchSync(): RootFileOpenBatchSync {
  const roots = new Map<string, RetainedRoot>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    let error: unknown;
    let failed = false;
    for (const { owner } of roots.values()) {
      try { owner.close(); } catch (cause) { if (!failed) { failed = true; error = cause; } }
    }
    roots.clear();
    if (failed) throw error;
  };
  return Object.freeze({
    openFile(input: OpenRootFileSyncParams): RootFileOpenResult {
      if (closed) return failure(new FsSafeError("invalid-path", "open batch is closed"));
      const params: OpenRootFileSyncParams = {
        absolutePath: input.absolutePath, rootPath: input.rootPath,
        boundaryLabel: input.boundaryLabel, rootRealPath: input.rootRealPath,
        maxBytes: input.maxBytes, rejectHardlinks: input.rejectHardlinks,
        rejectSymlinks: input.rejectSymlinks, symlinks: input.symlinks,
        allowedType: input.allowedType, skipLexicalRootCheck: input.skipLexicalRootCheck,
        ioFs: input.ioFs,
      };
      try {
        if (!canRetainRoot(params)) return openRootFileSync(params);
        const binding = getNativeBinding("openBeneath");
        const openBeneath = binding?.openBeneath;
        if (!binding || !openBeneath) return openRootFileSync(params);
        let retained = roots.get(params.rootPath);
        if (!retained) {
          if (realpathSync(params.rootPath) !== params.rootPath) return openRootFileSync(params);
          const observation = observeCanonicalRoot(fs, params.rootPath);
          if (!observation.ok) return failure(observation.error);
          const owner = openExactNativeRootSync(binding, { rootPath: observation.path, rootIdentity: observation.identity });
          retained = { owner, observation };
          roots.set(params.rootPath, retained);
        }
        const { owner, observation } = retained;
        inspectDirectoryIdentitySync(observation.path, observation.identity);
        let admittedFd: number;
        try {
          // Reject reparses before any full-leaf pathname observation can follow them.
          admittedFd = openBeneath.call(binding, owner.fd,
            path.relative(params.rootPath, params.absolutePath), resolveReadOpenFlags()).fd;
        } catch (error) {
          const failure = error as NodeJS.ErrnoException | undefined;
          if (failure?.code === "ELOOP" || failure?.errno === WINDOWS_ERROR_REPARSE_POINT_ENCOUNTERED) {
            throw new FsSafeError("symlink", "symlink not allowed", { cause: error });
          }
          throw error;
        }
        return openRootFileWithRetainedRootSync(params, observation, admittedFd);
      } catch (error) { return failure(error); }
    },
    close,
    [Symbol.dispose]: close,
  });
}
