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

const { tempRoot } = useTempDirs();
const DESTINATION_WRITE_FLAGS =
  fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL;
const FALSY_FAILURES = [undefined, null, false, 0, -0, 0n, "", Number.NaN] as const;
const CLOSE_FAILURES = [new Error("destination close failed"), ...FALSY_FAILURES] as const;

type Failure = { enabled: true; value: unknown } | { enabled: false };
type Settlement = { failed: true; value: unknown } | { failed: false };

const noFailure: Failure = { enabled: false };

function bindHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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

describe("unsynchronized copy-fallback destination close settlement", () => {
  it("surfaces an Error and every falsy async close rejection for absent and existing destinations", async () => {
    const root = await tempRoot("fs-safe-copy-close-async-");
    for (const [failureIndex, closeFailure] of CLOSE_FAILURES.entries()) {
      for (const [layout, restore] of [
        ["absent", "none"], ["existing", "none"], ["absent-restore", "restore-original"],
      ] as const) {
        const dest = path.join(root, `${failureIndex}-${layout}`);
        if (layout === "existing") await fs.writeFile(dest, "original");
        const adapter = asyncAdapter({ dest, closeFailure, operationFailure: noFailure });
        let tempPath: string | undefined;
        const settlement = await captureAsync(() => replaceFileAtomic({
          filePath: dest,
          content: "replacement",
          fileSystem: adapter.fileSystem,
          copyFallbackOnPermissionError: true,
          copyFallbackRestore: restore,
          maxRestoreBytes: 64,
          syncTempFile: false,
          syncParentDir: false,
          beforeRename: async (receipt) => { tempPath = receipt.tempPath; },
        }));

        expectFailure(settlement, closeFailure);
        expect(adapter.closeAttempts()).toBe(1);
        await expect(fs.readFile(dest, "utf8")).resolves.toBe("replacement");
        expect(tempPath).toBeDefined();
        expect(fsSync.existsSync(tempPath!)).toBe(false);
      }
    }
  });

  it("surfaces an Error and every falsy sync close throw for absent and existing destinations", async () => {
    const root = await tempRoot("fs-safe-copy-close-sync-");
    for (const [failureIndex, closeFailure] of CLOSE_FAILURES.entries()) {
      for (const [layout, restore] of [
        ["absent", "none"], ["existing", "none"], ["absent-restore", "restore-original"],
      ] as const) {
        const dest = path.join(root, `${failureIndex}-${layout}`);
        if (layout === "existing") fsSync.writeFileSync(dest, "original");
        const adapter = syncAdapter({ dest, closeFailure, operationFailure: noFailure });
        let tempPath: string | undefined;
        const settlement = captureSync(() => replaceFileAtomicSync({
          filePath: dest,
          content: "replacement",
          fileSystem: adapter.fileSystem,
          copyFallbackOnPermissionError: true,
          copyFallbackRestore: restore,
          maxRestoreBytes: 64,
          syncTempFile: false,
          syncParentDir: false,
          beforeRename: (receipt) => { tempPath = receipt.tempPath; },
        }));

        expectFailure(settlement, closeFailure);
        expect(adapter.closeAttempts()).toBe(1);
        expect(fsSync.readFileSync(dest, "utf8")).toBe("replacement");
        expect(tempPath).toBeDefined();
        expect(fsSync.existsSync(tempPath!)).toBe(false);
      }
    }
  });

  it("preserves every earlier falsy async failure when destination close also rejects", async () => {
    const root = await tempRoot("fs-safe-copy-double-async-");
    for (const [failureIndex, operationFailure] of FALSY_FAILURES.entries()) {
      for (const [layout, restore] of [
        ["absent", "none"], ["existing", "none"], ["absent-restore", "restore-original"],
      ] as const) {
        const dest = path.join(root, `${failureIndex}-${layout}`);
        if (layout === "existing") await fs.writeFile(dest, "original");
        const adapter = asyncAdapter({
          dest,
          closeFailure: new Error("close failed"),
          operationFailure: { enabled: true, value: operationFailure },
        });
        let tempPath: string | undefined;
        const settlement = await captureAsync(() => replaceFileAtomic({
          filePath: dest,
          content: "replacement",
          fileSystem: adapter.fileSystem,
          copyFallbackOnPermissionError: true,
          copyFallbackRestore: restore,
          maxRestoreBytes: 64,
          syncTempFile: false,
          syncParentDir: false,
          beforeRename: async (receipt) => { tempPath = receipt.tempPath; },
        }));

        expectFailure(settlement, operationFailure);
        expect(adapter.closeAttempts()).toBe(1);
        await expect(fs.readFile(dest)).resolves.toHaveLength(0);
        expect(tempPath).toBeDefined();
        expect(fsSync.existsSync(tempPath!)).toBe(false);
      }
    }
  });

  it("preserves every earlier falsy sync failure when destination close also throws", async () => {
    const root = await tempRoot("fs-safe-copy-double-sync-");
    for (const [failureIndex, operationFailure] of FALSY_FAILURES.entries()) {
      for (const [layout, restore] of [
        ["absent", "none"], ["existing", "none"], ["absent-restore", "restore-original"],
      ] as const) {
        const dest = path.join(root, `${failureIndex}-${layout}`);
        if (layout === "existing") fsSync.writeFileSync(dest, "original");
        const adapter = syncAdapter({
          dest,
          closeFailure: new Error("close failed"),
          operationFailure: { enabled: true, value: operationFailure },
        });
        let tempPath: string | undefined;
        const settlement = captureSync(() => replaceFileAtomicSync({
          filePath: dest,
          content: "replacement",
          fileSystem: adapter.fileSystem,
          copyFallbackOnPermissionError: true,
          copyFallbackRestore: restore,
          maxRestoreBytes: 64,
          syncTempFile: false,
          syncParentDir: false,
          beforeRename: (receipt) => { tempPath = receipt.tempPath; },
        }));

        expectFailure(settlement, operationFailure);
        expect(adapter.closeAttempts()).toBe(1);
        expect(fsSync.readFileSync(dest)).toHaveLength(0);
        expect(tempPath).toBeDefined();
        expect(fsSync.existsSync(tempPath!)).toBe(false);
      }
    }
  });
});
