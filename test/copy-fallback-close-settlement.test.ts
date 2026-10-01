import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  replaceFileAtomic,
  replaceFileAtomicSync,
  type ReplaceFileAtomicFileSystem,
  type ReplaceFileAtomicSyncFileSystem,
} from "../src/atomic.js";
import { useTempDirs } from "./helpers/vitest.js";
import { bindHandle } from "./helpers/file-handle-proxy.js";

const { tempRoot } = useTempDirs();
const DESTINATION_WRITE_FLAGS =
  fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL;
const FALSY_FAILURES = [undefined, null, false, 0, -0, 0n, "", Number.NaN] as const;
const CLOSE_FAILURES = [new Error("destination close failed"), ...FALSY_FAILURES] as const;

type Failure = { enabled: true; value: unknown } | { enabled: false };
type Settlement = { failed: true; value: unknown } | { failed: false };

const noFailure: Failure = { enabled: false };

function isDestinationWriter(candidate: fsSync.PathLike, flags: string | number, dest: string): boolean {
  return String(candidate) === dest && typeof flags === "number" &&
    (flags & DESTINATION_WRITE_FLAGS) === DESTINATION_WRITE_FLAGS;
}

function asyncAdapter(params: {
  dest: string;
  closeFailure: unknown;
  operationFailure: Failure;
}): { fileSystem: ReplaceFileAtomicFileSystem; closeAttempts: () => number } {
  let attempts = 0;
  const promises = {
    ...fs,
    async rename() {
      throw Object.assign(new Error("force copy fallback"), { code: "EPERM" });
    },
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      if (!isDestinationWriter(args[0], args[1], params.dest)) return handle;
      return bindHandle(handle, {
        ...(params.operationFailure.enabled ? {
          writeFile: (async () => {
            throw params.operationFailure.value;
          }) as FileHandle["writeFile"],
        } : {}),
        async close() {
          attempts += 1;
          await handle.close();
          throw params.closeFailure;
        },
      });
    },
  };
  return { fileSystem: { promises }, closeAttempts: () => attempts };
}

function syncAdapter(params: {
  dest: string;
  closeFailure: unknown;
  operationFailure: Failure;
}): { fileSystem: ReplaceFileAtomicSyncFileSystem; closeAttempts: () => number } {
  let destinationFd: number | undefined;
  let attempts = 0;
  const fileSystem: ReplaceFileAtomicSyncFileSystem = {
    ...fsSync,
    renameSync() {
      throw Object.assign(new Error("force copy fallback"), { code: "EPERM" });
    },
    openSync(candidate, flags, mode) {
      const fd = fsSync.openSync(candidate, flags, mode);
      if (isDestinationWriter(candidate, flags, params.dest)) destinationFd = fd;
      return fd;
    },
    writeSync(fd, buffer, offset, length, position) {
      if (fd === destinationFd && params.operationFailure.enabled) {
        throw params.operationFailure.value;
      }
      return fsSync.writeSync(fd, buffer, offset, length, position);
    },
    closeSync(fd) {
      if (fd !== destinationFd) return fsSync.closeSync(fd);
      attempts += 1;
      fsSync.closeSync(fd);
      throw params.closeFailure;
    },
  };
  return { fileSystem, closeAttempts: () => attempts };
}

async function captureAsync(run: () => Promise<unknown>): Promise<Settlement> {
  try {
    await run();
    return { failed: false };
  } catch (value) {
    return { failed: true, value };
  }
}

function captureSync(run: () => unknown): Settlement {
  try {
    run();
    return { failed: false };
  } catch (value) {
    return { failed: true, value };
  }
}

function expectFailure(settlement: Settlement, expected: unknown): void {
  expect(settlement.failed).toBe(true);
  if (settlement.failed) expect(Object.is(settlement.value, expected)).toBe(true);
}

describe.each(["async", "sync"] as const)("unsynchronized %s copy-fallback destination close settlement", (mode) => {
  it.each([
    { scenario: "close-only failure", failures: CLOSE_FAILURES, earlierFailure: false },
    { scenario: "earlier operation failure", failures: FALSY_FAILURES, earlierFailure: true },
  ])("preserves exact $scenario settlement across destination layouts", async ({ failures, earlierFailure }) => {
    const root = await tempRoot(`fs-safe-copy-close-${mode}-`);
    let executions = 0;
    for (const [failureIndex, failure] of failures.entries()) {
      for (const [layout, restore] of [
        ["absent", "none"], ["existing", "none"], ["absent-restore", "restore-original"],
      ] as const) {
        const dest = path.join(root, `${failureIndex}-${layout}`);
        if (layout === "existing") await fs.writeFile(dest, "original");
        const params = {
          dest,
          closeFailure: earlierFailure ? new Error("close failed") : failure,
          operationFailure: earlierFailure ? { enabled: true, value: failure } as const : noFailure,
        };
        let tempPath: string | undefined;
        const options = {
          filePath: dest,
          content: "replacement",
          copyFallbackOnPermissionError: true,
          copyFallbackRestore: restore,
          maxRestoreBytes: 64,
          syncTempFile: false,
          syncParentDir: false,
        };
        let settlement: Settlement;
        let closeAttempts: () => number;
        if (mode === "async") {
          const adapter = asyncAdapter(params);
          closeAttempts = adapter.closeAttempts;
          settlement = await captureAsync(() => replaceFileAtomic({
            ...options,
            fileSystem: adapter.fileSystem,
            beforeRename: async (receipt) => { tempPath = receipt.tempPath; },
          }));
        } else {
          const adapter = syncAdapter(params);
          closeAttempts = adapter.closeAttempts;
          settlement = captureSync(() => replaceFileAtomicSync({
            ...options,
            fileSystem: adapter.fileSystem,
            beforeRename: (receipt) => { tempPath = receipt.tempPath; },
          }));
        }
        executions += 1;

        expectFailure(settlement, failure);
        expect(closeAttempts()).toBe(1);
        await expect(fs.readFile(dest, "utf8")).resolves.toBe(earlierFailure ? "" : "replacement");
        expect(tempPath).toBeDefined();
        expect(fsSync.existsSync(tempPath!)).toBe(false);
      }
    }
    expect(executions).toBe(earlierFailure ? 24 : 27);
  });
});
