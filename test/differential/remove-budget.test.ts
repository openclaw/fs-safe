import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root } from "../../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../../src/native.js";
import { loadTestNative } from "../helpers/native-probe.js";
import { useRealTempDirs } from "../helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const native = loadTestNative("required-env");
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

describe.each(["off", "require", "auto"] as const)("recursive removal budget (%s)", mode => {
  it.for([false, true])("counts a missing requested entry before force=%s can ignore it", async (force, context) => {
    if (mode !== "off" && !native) context.skip("Native binding unavailable");
    if (native) __setNativeLoaderForTest(() => native);
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-remove-budget-");
    fs.mkdirSync(path.join(directory, "parent"));
    const files = await root(directory);
    await expect(files.remove("parent/missing", { recursive: true, force, maxEntries: 0 })).rejects.toMatchObject({
      name: "FsSafeError", code: "too-large", details: { operation: "remove", phase: "inspect", relativePath: "" },
    });
    expect(fs.readdirSync(path.join(directory, "parent"))).toEqual([]);
    if (force) await expect(files.remove("parent/missing", { recursive: true, force, maxEntries: 1 })).resolves.toBeUndefined();
    else await expect(files.remove("parent/missing", { recursive: true, force, maxEntries: 1 })).rejects.toMatchObject({ code: "not-found" });
  });
});
