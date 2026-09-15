import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const supportsSearchOnlyDirectory =
  (process.platform === "linux" || process.platform === "darwin") &&
  (process.arch === "x64" || process.arch === "arm64");

afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.runIf(supportsSearchOnlyDirectory)("temp workspace cleanup descriptor access", () => {
  function availableCleanupBinding() {
    return {
      renameNoReplace: vi.fn(),
      removeOwnedTree: vi.fn(),
      removeOwnedTreeSync: vi.fn(),
      ownedTreeRemovalAvailable: vi.fn(() => true),
    };
  }

  function forceSearchOnlyChild(
    rootDir: string,
    deniedReadableAttempts: readonly number[] = [1, 3],
  ): () => number {
    let attempts = 0;
    const open = fsSync.openSync;
    vi.spyOn(fsSync, "openSync").mockImplementation((name, ...args) => {
      if (
        typeof name === "string" && path.dirname(name) === rootDir &&
        path.basename(name).startsWith("workspace-")
      ) {
        attempts += 1;
        // Initial O_RDONLY, search-only fallback, then cleanup-read O_RDONLY.
        if (deniedReadableAttempts.includes(attempts)) {
          throw Object.assign(new Error("read access denied"), { code: "EACCES" });
        }
      }
      return open(name, ...args);
    });
    return () => attempts;
  }

  it.each(["async", "sync"] as const)(
    "never transfers a search-only %s child descriptor to native cleanup", async (variant) => {
      const rootDir = await tempRoot("fs-safe-workspace-search-only-");
      configureFsSafeNative({ mode: "auto" });
      const binding = availableCleanupBinding();
      __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
      const forced = forceSearchOnlyChild(rootDir);
      const workspace = variant === "async"
        ? await tempWorkspace({ rootDir, prefix: "workspace-" })
        : tempWorkspaceSync({ rootDir, prefix: "workspace-" });
      expect(forced()).toBe(3);
      await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
      expect(await workspace.cleanup()).toBe("removed");
      expect(binding.ownedTreeRemovalAvailable).toHaveBeenCalledTimes(1);
      expect(binding.renameNoReplace).not.toHaveBeenCalled();
      expect(binding.removeOwnedTree).not.toHaveBeenCalled();
      expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();
    },
  );

  it.each(["async", "sync"] as const)(
    "reuses the retained search-only %s descriptor for mode correction", async (variant) => {
      const rootDir = await tempRoot("fs-safe-workspace-search-mode-");
      configureFsSafeNative({ mode: "off" });
      const forced = forceSearchOnlyChild(rootDir, [1]);
      const options = { rootDir, prefix: "workspace-", dirMode: 0o750 };
      let workspace;
      if (variant === "async") {
        workspace = await tempWorkspace(options);
      } else if (process.platform === "linux") {
        const previous = process.umask(0o077);
        try {
          workspace = tempWorkspaceSync(options);
        } finally {
          process.umask(previous);
        }
      } else {
        workspace = tempWorkspaceSync(options);
      }
      expect(forced()).toBe(3);
      expect(fsSync.statSync(workspace.dir).mode & 0o7777).toBe(0o750);
      expect(await workspace.cleanup()).toBe("removed");
    },
  );

  it.each(["async", "sync"] as const)(
    "rejects require-bounded %s cleanup when only a search child fd is available", async (variant) => {
      const rootDir = await tempRoot("fs-safe-workspace-search-required-");
      configureFsSafeNative({ mode: "require" });
      const binding = availableCleanupBinding();
      __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
      const forced = forceSearchOnlyChild(rootDir);
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(async () => variant === "async"
        ? await tempWorkspace({ rootDir, prefix: "workspace-", cleanupSafety: "require-bounded" })
        : tempWorkspaceSync({ rootDir, prefix: "workspace-", cleanupSafety: "require-bounded" }))
        .rejects.toMatchObject({ code: "helper-unavailable" });
      expect(forced()).toBe(3);
      expect(register).not.toHaveBeenCalled();
      expect(binding.renameNoReplace).not.toHaveBeenCalled();
      expect(binding.removeOwnedTree).not.toHaveBeenCalled();
      expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();
      expect((await fs.readdir(rootDir)).some((name) => name.startsWith("workspace-"))).toBe(true);
    },
  );

  it.each(["async", "sync"] as const)(
    "does not retry indeterminate descriptor closes during %s factory admission", async (variant) => {
      const rootDir = await tempRoot("fs-safe-workspace-replacement-close-");
      configureFsSafeNative({ mode: "auto" });
      const binding = availableCleanupBinding();
      __setNativeLoaderForTest(() => binding as unknown as NativeBinding);

      const originalOpen = fsSync.openSync;
      const originalClose = fsSync.closeSync;
      let childOpenAttempts = 0;
      let searchFd: number | undefined;
      let readableFd: number | undefined;
      vi.spyOn(fsSync, "openSync").mockImplementation((name, ...args) => {
        if (
          typeof name === "string" && path.dirname(name) === rootDir &&
          path.basename(name).startsWith("workspace-")
        ) {
          childOpenAttempts += 1;
          if (childOpenAttempts === 1) {
            throw Object.assign(new Error("read access denied"), { code: "EACCES" });
          }
          const fd = originalOpen(name, ...args);
          if (childOpenAttempts === 2) searchFd = fd;
          if (childOpenAttempts === 3) readableFd = fd;
          return fd;
        }
        return originalOpen(name, ...args);
      });

      const previousCloseFailure = Object.assign(new Error("injected search close failure"), {
        code: "EIO",
      });
      const replacementCloseFailure = Object.assign(new Error("injected readable close failure"), {
        code: "EIO",
      });
      let searchCloseAttempts = 0;
      let readableCloseAttempts = 0;
      vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
        if (fd === searchFd) {
          searchCloseAttempts += 1;
          throw previousCloseFailure;
        }
        if (fd === readableFd) {
          readableCloseAttempts += 1;
          // Model a close that releases the descriptor but reports an error;
          // ownership is still indeterminate and must not be retried.
          originalClose(fd);
          throw replacementCloseFailure;
        }
        return originalClose(fd);
      });
      const register = vi.spyOn(cleanup, "registerTempPathForExit");

      try {
        const operation = async () => variant === "async"
          ? await tempWorkspace({ rootDir, prefix: "workspace-" })
          : tempWorkspaceSync({ rootDir, prefix: "workspace-" });
        const rejection = await operation().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(rejection).toBeInstanceOf(AggregateError);
        expect((rejection as AggregateError).message)
          .toBe("temp workspace child descriptor replacement close failed");
        expect((rejection as AggregateError).errors)
          .toEqual([previousCloseFailure, replacementCloseFailure]);
        expect(childOpenAttempts).toBe(3);
        expect(searchCloseAttempts).toBe(1);
        expect(readableCloseAttempts).toBe(1);
        expect(register).not.toHaveBeenCalled();
        expect(binding.renameNoReplace).not.toHaveBeenCalled();
        expect(binding.removeOwnedTree).not.toHaveBeenCalled();
        expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();
        expect((await fs.readdir(rootDir)).some((name) => name.startsWith("workspace-"))).toBe(true);
        expect(() => fsSync.fstatSync(readableFd!))
          .toThrowError(expect.objectContaining({ code: "EBADF" }));
      } finally {
        // The injected previous close failure deliberately leaves this test fd
        // open. Test teardown, unlike production, knows that simulated state.
        if (searchFd !== undefined) {
          try { originalClose(searchFd); } catch { /* already closed */ }
        }
        if (readableFd !== undefined) {
          try { originalClose(readableFd); } catch { /* already closed */ }
        }
      }
    },
  );
});
