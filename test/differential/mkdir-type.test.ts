import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root } from "../../src/root.js";
import { FsSafeError } from "../../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../../src/native.js";
import { loadTestNative } from "../helpers/native-probe.js";
import { useRealTempDirs } from "../helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const native = loadTestNative("required-env");
afterEach(() => { __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

describe.each(["off", "require", "auto"] as const)("mkdir type admission (%s)", mode => {
  it.for(["file", "file/child"])("preserves typed admission for %s without changing the file", async (target, context) => {
    if (mode !== "off" && !native) context.skip("Native binding unavailable");
    if (native) __setNativeLoaderForTest(() => native);
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-mkdir-type-");
    fs.writeFileSync(path.join(directory, "file"), "sentinel");
    const files = await root(directory);
    await expect(files.mkdir(target)).rejects.toMatchObject({ name: "FsSafeError", code: target === "file" ? "not-file" : "path-alias" });
    expect(fs.readFileSync(path.join(directory, "file"), "utf8")).toBe("sentinel");
    expect(fs.readdirSync(directory)).toEqual(["file"]);
  });

  it("preserves an authority rejection carrying ENOTDIR", async context => {
    if (mode !== "off" && !native) context.skip("Native binding unavailable");
    if (native) __setNativeLoaderForTest(() => native);
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-mkdir-authority-type-");
    const files = await root(directory);
    const rejection = Object.assign(new Error("authority revoked"), { code: "ENOTDIR" });
    await expect(files.mkdir("child", { assertBeforeMutation() { throw rejection; } })).rejects.toBe(rejection);
    expect(rejection).not.toBeInstanceOf(FsSafeError);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
