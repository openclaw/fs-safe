import fsSync from "node:fs";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { TempWorkspaceCleanupCapability } from "../src/temp-workspace-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

const FALSY_THROWN_VALUES = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "+0", value: +0 },
  { label: "-0", value: -0 },
  { label: "empty string", value: "" },
  { label: "0n", value: 0n },
  { label: "NaN", value: Number.NaN },
] as const;

type AsyncSettlement<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

type SyncSettlement<T> =
  | { readonly status: "returned"; readonly value: T }
  | { readonly status: "threw"; readonly reason: unknown };

async function settleAsync<T>(run: () => Promise<T>): Promise<AsyncSettlement<T>> {
  try {
    return { status: "fulfilled", value: await run() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function settleSync<T>(run: () => T): SyncSettlement<T> {
  try {
    return { status: "returned", value: run() };
  } catch (reason) {
    return { status: "threw", reason };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe("compatible temp-workspace falsy cleanup failures", () => {
  for (const testCase of FALSY_THROWN_VALUES) {
    it(`preserves an async recursive-removal throw of ${testCase.label}`, async () => {
      configureFsSafeNative({ mode: "off" });
      const rootDir = await tempRoot("fs-safe-workspace-falsy-rm-async-");
      const workspace = await tempWorkspace({ rootDir, prefix: "workspace-" });
      const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(testCase.value);

      const settlement = await settleAsync(() => workspace.cleanup());

      expect(settlement.status).toBe("rejected");
      if (settlement.status !== "rejected") throw new Error("cleanup unexpectedly fulfilled");
      expect(Object.is(settlement.reason, testCase.value)).toBe(true);
      expect(remove).toHaveBeenCalledTimes(1);
      await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(workspace.cleanup()).resolves.toBe("indeterminate");
    });

    it(`preserves a sync recursive-removal throw of ${testCase.label}`, async () => {
      configureFsSafeNative({ mode: "off" });
      const rootDir = await tempRoot("fs-safe-workspace-falsy-rm-sync-");
      const workspace = tempWorkspaceSync({ rootDir, prefix: "workspace-" });
      const remove = vi.spyOn(fsSync, "rmSync").mockImplementationOnce(() => {
        throw testCase.value;
      });

      const settlement = settleSync(() => workspace.cleanup());

      expect(settlement.status).toBe("threw");
      if (settlement.status !== "threw") throw new Error("cleanup unexpectedly returned");
      expect(Object.is(settlement.reason, testCase.value)).toBe(true);
      expect(remove).toHaveBeenCalledTimes(1);
      await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(workspace.cleanup()).toBe("indeterminate");
    });

    it(`maps an async quarantine guard throw of ${testCase.label} to indeterminate`, async () => {
      configureFsSafeNative({ mode: "off" });
      const rootDir = await tempRoot("fs-safe-workspace-falsy-guard-async-");
      const workspace = await tempWorkspace({ rootDir, prefix: "workspace-" });
      const original = TempWorkspaceCleanupCapability.prototype.assertCurrent;
      let assertions = 0;
      vi.spyOn(TempWorkspaceCleanupCapability.prototype, "assertCurrent")
        .mockImplementation(function (this: TempWorkspaceCleanupCapability) {
          assertions += 1;
          // Five parent checks admit and verify quarantine. The sixth is the
          // removal guard whose uncertainty must not impersonate rm failure.
          if (assertions === 6) throw testCase.value;
          original.call(this);
        });
      const remove = vi.spyOn(fs, "rm");

      const settlement = await settleAsync(() => workspace.cleanup());

      expect(settlement.status).toBe("fulfilled");
      if (settlement.status !== "fulfilled") throw new Error("cleanup unexpectedly rejected");
      expect(settlement.value).toBe("indeterminate");
      expect(assertions).toBe(6);
      expect(remove).not.toHaveBeenCalled();
      await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it(`maps a sync quarantine guard throw of ${testCase.label} to indeterminate`, async () => {
      configureFsSafeNative({ mode: "off" });
      const rootDir = await tempRoot("fs-safe-workspace-falsy-guard-sync-");
      const workspace = tempWorkspaceSync({ rootDir, prefix: "workspace-" });
      const original = TempWorkspaceCleanupCapability.prototype.assertCurrent;
      let assertions = 0;
      vi.spyOn(TempWorkspaceCleanupCapability.prototype, "assertCurrent")
        .mockImplementation(function (this: TempWorkspaceCleanupCapability) {
          assertions += 1;
          if (assertions === 6) throw testCase.value;
          original.call(this);
        });
      const remove = vi.spyOn(fsSync, "rmSync");

      const settlement = settleSync(() => workspace.cleanup());

      expect(settlement.status).toBe("returned");
      if (settlement.status !== "returned") throw new Error("cleanup unexpectedly threw");
      expect(settlement.value).toBe("indeterminate");
      expect(assertions).toBe(6);
      expect(remove).not.toHaveBeenCalled();
      await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
});
