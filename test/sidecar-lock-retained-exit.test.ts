import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { __loadBundledNativeForTest } from "../src/native.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";

const exec = promisify(execFile);
const { tempRoot } = useRealTempDirs();
allowWindowsFilesystemStalls();
let native;
try { native = __loadBundledNativeForTest(); } catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const cases = process.platform === "win32"
  ? ["control", "root-replaced", "root-moved"] as const
  : ["control", "parent-symlink", "root-replaced", "root-moved"] as const;
async function child(base: string, kind: string, action: string) {
  const result = await exec(process.execPath, [
    fileURLToPath(new URL("./fixtures/sidecar-retained-child.mjs", import.meta.url)), base, kind, action,
  ], { env: { ...process.env, FS_SAFE_NATIVE_MODE: "require" }, timeout: 10_000 });
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

describe.skipIf(!native)("retained sidecar process cleanup", () => {
  it.runIf(process.platform === "win32").each(["natural", "explicit"])(
    "closes the Windows ancestor pin on %s exit", async action => {
      const base = await tempRoot("sidecar-retained-ancestor-exit-");
      expect(await child(base, "ancestor-pinned", action)).toBe("acquired");
      const parent = path.join(base, "parent");
      expect(await fs.readdir(path.join(parent, "data"))).toEqual([]);
      await fs.rename(parent, `${parent}-moved`);
      await fs.rename(`${parent}-moved`, parent);
      expect(await child(base, "control", "reacquire")).toBe("acquired");
    },
  );
  it.each(cases.flatMap(kind => ["release", "natural", "explicit"].map(action => ({ kind, action }))))(
    "$action cleanup after $kind permits a fresh process to acquire", async ({ kind, action }) => {
      const base = await tempRoot("sidecar-retained-exit-");
      expect(await child(base, kind, action)).toBe("acquired");
      const parent = path.join(base, "parent"), directory = path.join(parent, "data");
      const physical = kind === "parent-symlink" ? path.join(base, "parent-moved", "data")
        : kind === "control" ? directory : path.join(parent, "data-moved");
      expect(await fs.readdir(physical)).toEqual([]);
      if (kind === "parent-symlink") {
        if (process.platform === "win32") await fs.rmdir(parent);
        else await fs.unlink(parent);
        await fs.rename(path.join(base, "parent-moved"), parent);
      } else if (kind !== "control") {
        if (kind === "root-replaced") await fs.rmdir(directory);
        await fs.rename(physical, directory);
      }
      expect(await child(base, "control", "reacquire")).toBe("acquired");
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );
  it("honors retainOnExit after relocation", async () => {
    const base = await tempRoot("sidecar-retained-keep-");
    await child(base, "root-moved", "retain");
    expect(await fs.readdir(path.join(base, "parent", "data-moved"))).toEqual(["state.lock"]);
  });
  it.skipIf(process.platform === "win32")("closes descriptors on release, reset, mismatch and failed acquisition", async () => {
    expect(await child(await tempRoot("sidecar-retained-leaks-"), "control", "leaks")).toBe("no-leaks");
  });
});
