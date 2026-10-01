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

afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.each(["async", "sync"] as const)("%s falsy cleanup failures", (mode) => {
  it.each(FALSY_THROWN_VALUES)("preserves a recursive-removal throw of $label", async ({ value }) => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot(`fs-safe-falsy-rm-${mode}-`);
    const options = { rootDir, prefix: "workspace-" };
    const workspace = mode === "sync" ? tempWorkspaceSync(options) : await tempWorkspace(options);
    const remove = mode === "sync"
      ? vi.spyOn(fsSync, "rmSync").mockImplementationOnce(() => { throw value; })
      : vi.spyOn(fs, "rm").mockRejectedValueOnce(value);
    let returned = false;
    let caught: unknown;
    try {
      // Invoke sync cleanup directly, preserving the synchronous throw contract.
      if (mode === "sync") workspace.cleanup();
      else await workspace.cleanup();
      returned = true;
    } catch (error) { caught = error; }
    expect(returned).toBe(false);
    expect(Object.is(caught, value)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
    if (mode === "sync") expect(workspace.cleanup()).toBe("indeterminate");
    else await expect(workspace.cleanup()).resolves.toBe("indeterminate");
  });

  it.each(FALSY_THROWN_VALUES)("maps a quarantine guard throw of $label to indeterminate", async ({ value }) => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot(`fs-safe-falsy-guard-${mode}-`);
    const options = { rootDir, prefix: "workspace-" };
    const workspace = mode === "sync" ? tempWorkspaceSync(options) : await tempWorkspace(options);
    const original = TempWorkspaceCleanupCapability.prototype.assertCurrent;
    let assertions = 0;
    vi.spyOn(TempWorkspaceCleanupCapability.prototype, "assertCurrent")
      .mockImplementation(function (this: TempWorkspaceCleanupCapability) {
        assertions += 1;
        // The sixth check guards removal after five parent/quarantine checks.
        if (assertions === 6) throw value;
        original.call(this);
      });
    const remove = mode === "sync" ? vi.spyOn(fsSync, "rmSync") : vi.spyOn(fs, "rm");
    if (mode === "sync") expect(workspace.cleanup()).toBe("indeterminate");
    else await expect(workspace.cleanup()).resolves.toBe("indeterminate");
    expect(assertions).toBe(6);
    expect(remove).not.toHaveBeenCalled();
    await expect(fs.lstat(workspace.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
