import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

it.each(["removed", "file"] as const)("keeps a typed stale-Root error when ensureRoot finds its directory %s", async replacement => {
  configureFsSafeNative({ mode: "off" });
  const parent = await tempRoot("fs-safe-ensure-root-stale-");
  const directory = path.join(parent, "root");
  fs.mkdirSync(directory);
  const safe = await root(directory);
  fs.rmdirSync(directory);
  if (replacement === "file") fs.writeFileSync(directory, "replacement");
  const load = vi.fn(() => ({
    openBeneath() { throw new Error("stale Root must reject before native dispatch"); },
    mkdirChildBeneath() { throw new Error("stale Root must not create a child"); },
    closeOwnedFd(fd: number) { fs.closeSync(fd); },
  }));
  __setNativeLoaderForTest(load);
  configureFsSafeNative({ mode: "require" });

  await expect(safe.ensureRoot()).rejects.toMatchObject({
    name: "FsSafeError", code: "path-mismatch",
  });
  expect(load).not.toHaveBeenCalled();
});
