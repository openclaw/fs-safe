import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { retireWindowsSourceNameSync } from "./windows-source-retirement.js";

export type SourceRecovery = Readonly<{ path: string; status: "preserved" | "indeterminate" }>;
export type SourceRetirementState = {
  sourceConsumed?: boolean;
  sourceRecovery?: SourceRecovery;
};

export type PortableSourceRetirementOptions = {
  sourcePath: string;
  sourceParentPath: string;
  sourceParentIdentity: Pick<BigIntStats, "dev" | "ino">;
  sourceFd: number;
  identity: BigIntStats;
  expectedLinks: bigint;
  assertBeforeMutation?: () => void;
  assertBeforeCapture: () => void;
  assertCaptured?: (capturePath: string) => void;
  assertAfterRetirement?: () => void;
  onState: (state: SourceRetirementState) => void;
};

function changed(): FsSafeError {
  return new FsSafeError("path-mismatch", "source changed during portable retirement");
}

function assertFile(inspect: () => BigIntStats, options: PortableSourceRetirementOptions, links: bigint): void {
  inspectFileIdentitySync(() => {
    const stat = inspect();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links) throw changed();
    return stat;
  }, options.identity);
}

function retirementFailure(error: unknown, state: SourceRetirementState): FsSafeError {
  return new FsSafeError(error instanceof FsSafeError ? error.code : "helper-failed", "portable source retirement failed", {
    cause: error,
    details: { ...(error instanceof FsSafeError ? error.details : {}), ...state },
  });
}

// The caller owns the retained source descriptor. Recovery paths describe
// preserved entries; they never grant authority for recursive cleanup.
export function retirePortableMoveSource(options: PortableSourceRetirementOptions): void {
  let state: SourceRetirementState = { sourceConsumed: false };
  const report = (next: SourceRetirementState) => { state = next; options.onState(next); };
  report(state);
  if (process.platform === "win32") {
    options.assertBeforeMutation?.();
    options.assertBeforeCapture();
    try {
      report({});
      retireWindowsSourceNameSync(options);
      report({ sourceConsumed: true });
      assertFile(() => fs.fstatSync(options.sourceFd, { bigint: true }), options, options.expectedLinks - 1n);
      options.assertAfterRetirement?.();
    } catch (error) {
      const commit = error instanceof FsSafeError ? error.details?.commit : undefined;
      if (state.sourceConsumed !== true) {
        if (commit === "not-attempted") report({ sourceConsumed: false });
        else if (commit === "committed") report({ sourceConsumed: true });
      }
      throw retirementFailure(error, state);
    }
    return;
  }

  const directory = path.join(options.sourceParentPath, `.fs-safe-move-${randomUUID()}`);
  const capture = path.join(directory, "source");
  let directoryIdentity: BigIntStats | undefined;
  let directoryFd: number | undefined;
  let captureAttempted = false;
  let captureCompleted = false;
  let unlinkAttempted = false;
  let retired = false;
  let failed = false;
  let operationError: unknown;
  const fail = (error: unknown): never => { failed = true; operationError = error; throw error; };
  const assertDirectory = () => {
    const stat = inspectDirectoryIdentitySync(directory, directoryIdentity);
    if (!directoryIdentity || stat.uid !== BigInt(process.geteuid!()) ||
      (stat.mode & 0o077n) !== 0n || realpathSync.native(directory) !== directory) throw changed();
    if (directoryFd !== undefined) {
      const opened = inspectFileIdentitySync(() => fs.fstatSync(directoryFd!, { bigint: true }), directoryIdentity);
      if (!opened.isDirectory() || opened.uid !== stat.uid || (opened.mode & 0o077n) !== 0n) throw changed();
    }
  };
  const removeEmptyDirectory = () => {
    options.assertBeforeMutation?.();
    inspectDirectoryIdentitySync(options.sourceParentPath, options.sourceParentIdentity);
    assertDirectory();
    // Never recurse: an unexpected captured entry must remain recoverable.
    fs.rmdirSync(directory);
  };
  const assertCapture = () => {
    assertDirectory();
    assertFile(() => fs.lstatSync(capture, { bigint: true }), options, options.expectedLinks);
    assertFile(() => fs.fstatSync(options.sourceFd, { bigint: true }), options, options.expectedLinks);
  };
  try {
    options.assertBeforeMutation?.();
    options.assertBeforeCapture();
    // Write/search access to the source parent is enough; never enumerate it.
    fs.mkdirSync(directory, { mode: 0o700 });
    directoryIdentity = inspectDirectoryIdentitySync(directory);
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    assertDirectory();
    options.assertBeforeMutation?.();
    options.assertBeforeCapture();
    assertDirectory();
    try {
      fs.lstatSync(capture);
      throw changed();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Disable empty-directory cleanup before dispatch, even when the rename's
    // reply is lost. There is no automatic restore to the public source name.
    captureAttempted = true;
    report({ sourceRecovery: { path: capture, status: "indeterminate" } });
    fs.renameSync(options.sourcePath, capture);
    captureCompleted = true;
    report({ sourceConsumed: false, sourceRecovery: { path: capture, status: "indeterminate" } });
    options.assertCaptured?.(capture);
    assertCapture();
    report({ sourceConsumed: false, sourceRecovery: { path: capture, status: "preserved" } });
    options.assertBeforeMutation?.();
    options.assertCaptured?.(capture);
    assertCapture();
    unlinkAttempted = true;
    report({ sourceRecovery: { path: capture, status: "indeterminate" } });
    fs.unlinkSync(capture);
    retired = true;
    report({ sourceConsumed: true });
    assertFile(() => fs.fstatSync(options.sourceFd, { bigint: true }), options, options.expectedLinks - 1n);
    options.assertAfterRetirement?.();
    removeEmptyDirectory();
  } catch (error) {
    if (!captureAttempted) {
      if (directoryIdentity) {
        try { removeEmptyDirectory(); } catch (cleanupError) {
          if (cleanupError === error) fail(error);
          fail(createSuppressedError(cleanupError, error, "source retirement preparation and empty-directory cleanup failed"));
        }
      }
      fail(error);
    }
    if (!retired) {
      let status: SourceRecovery["status"] = "indeterminate";
      if (captureCompleted && !unlinkAttempted) {
        try { assertDirectory(); fs.lstatSync(capture); status = "preserved"; } catch { /* Preserve uncertain captures too. */ }
      }
      report({
        ...(state.sourceConsumed === false && !unlinkAttempted ? { sourceConsumed: false } : {}),
        sourceRecovery: { path: capture, status },
      });
    }
    fail(retirementFailure(error, state));
  } finally {
    if (directoryFd !== undefined) {
      try { fs.closeSync(directoryFd); } catch (closeError) {
        const failure = captureAttempted ? retirementFailure(closeError, state) : closeError;
        if (failed) throw createSuppressedError(failure, operationError, "source retirement and directory descriptor close failed");
        throw failure;
      }
    }
  }
}
