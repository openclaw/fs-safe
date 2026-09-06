import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { createNativeStage, assertNativeStaging } from "../src/native-staged-file.js";
import { openStagedDirectory } from "../src/staged-directory.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = process.platform !== "win32";
} catch {
  // Native CI provides the binding; fallback-only installations skip this suite.
}
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe.runIf(nativeAvailable)("native staged publication durability", () => {
  it.each([0o000, 0o200, 0o400, 0o600, 0o644, 0o777])("syncs mode %i according to its owner permissions", async (mode) => {
    const directory = await tempRoot("fs-safe-staged-sync-");
    const binding = __loadBundledNativeForTest();
    assertNativeStaging(binding);
    const parent = openStagedDirectory(directory);
    const sync = fsSync.fsyncSync;
    const events: string[] = [];
    vi.spyOn(fsSync, "fsyncSync").mockImplementation((fd) => {
      events.push(fsSync.fstatSync(fd).isFile() ? "file" : "parent");
      sync(fd);
    });
    const chmod = vi.spyOn(fsSync, "fchmodSync");
    await using staged = await createNativeStage(
      binding, parent.fd, parent.receipt, { kind: "buffer", data: "payload" }, mode,
    );
    expect(events).toEqual(["file"]);
    chmod.mockClear();
    await staged.publish("target", { overwrite: true });
    expect(events).toEqual((mode & 0o600) === 0o600 ? ["file", "parent"] : ["file", "file", "parent"]);
    expect(chmod).toHaveBeenCalledTimes(mode === 0o600 ? 0 : 1);
    const target = path.join(directory, "target");
    expect((await fs.stat(target)).mode & 0o777).toBe(mode);
    await fs.chmod(target, 0o600);
    expect(await fs.readFile(target, "utf8")).toBe("payload");
  });

  it.each([0o600, 0o644].flatMap((mode) => [0o400, 0o666].map((changedMode) => ({ mode, changedMode }))))(
    "restores mode $mode after staged permissions change to $changedMode",
    async ({ mode, changedMode }) => {
      const directory = await tempRoot("fs-safe-staged-mode-drift-");
      const binding = __loadBundledNativeForTest();
      assertNativeStaging(binding);
      const parent = openStagedDirectory(directory);
      await using staged = await createNativeStage(
        binding, parent.fd, parent.receipt, { kind: "buffer", data: "payload" }, mode,
      );
      await fs.chmod(path.join(directory, staged.receipt.temporaryBasename), changedMode);
      const sync = vi.spyOn(fsSync, "fsyncSync");
      await staged.publish("target", { overwrite: true });
      expect(sync).toHaveBeenCalledTimes(changedMode === 0o666 ? 2 : 1);
      expect((await fs.stat(path.join(directory, "target"))).mode & 0o777).toBe(mode);
      expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("payload");
    },
  );
});
