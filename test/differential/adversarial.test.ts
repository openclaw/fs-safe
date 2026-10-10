import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root } from "../../src/root.js";
import { FsSafeError } from "../../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../../src/native.js";
import { __setFsSafeTestHooksForTest } from "../../src/test-hooks.js";
import { loadTestNative } from "../helpers/native-probe.js";
import { useRealTempDirs } from "../helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const native = loadTestNative("required-env");
afterEach(() => {
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.each(["off", "require", "auto"] as const)("publication schedules (%s)", mode => {
  const schedules = (["write", "create", "copyIn"] as const).flatMap(method =>
    (["parent", "leaf"] as const).map(swap => ({ method, swap })));
  it.for(schedules)("$method rejects a substituted $swap before admission", async ({ method, swap }, context) => {
    if (mode !== "off" && !native) context.skip("Native binding unavailable");
    if (native) __setNativeLoaderForTest(() => native);
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-diff-swap-");
    const boundary = path.join(directory, "root");
    const parent = path.join(boundary, "parent");
    const outside = path.join(directory, "outside");
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(outside);
    const source = path.join(directory, "source");
    fs.writeFileSync(source, "new bytes");
    fs.writeFileSync(path.join(outside, "sentinel"), "outside");
    const files = await root(boundary, { durable: false, mutationSymlinks: "reject" });
    let swapped = false;
    __setFsSafeTestHooksForTest({ beforePinnedWriteParentAdmission() {
      if (swapped) return;
      if (swap === "parent") {
        fs.renameSync(parent, path.join(boundary, "saved"));
        fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
      } else fs.symlinkSync(path.join(outside, "sentinel"), path.join(parent, "output"), "file");
      swapped = true;
    } });
    let failure: unknown;
    try {
      if (method === "copyIn") await files.copyIn("parent/output", source);
      else await files[method]("parent/output", "new bytes");
    } catch (error) { failure = error; }
    expect(swapped).toBe(true);
    expect(failure).toBeInstanceOf(FsSafeError);
    expect(["outside-workspace", "path-mismatch", "symlink", "path-alias"]).toContain((failure as FsSafeError).code);
    expect(fs.readdirSync(outside)).toEqual(["sentinel"]);
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("outside");
    if (swap === "parent") expect(fs.readdirSync(path.join(boundary, "saved"))).toEqual([]);
    else expect(fs.lstatSync(path.join(parent, "output")).isSymbolicLink()).toBe(true);
  });
});
