import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); }
catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }

it.runIf(native?.rootRemovalUnlink && !process.versions.bun).each(["remove", "move"])(
  "pins %s async resource counts in every native mode", operation => {
    expect(() => execFileSync(process.execPath, ["scripts/native-call-budget-proof.mjs", "--resources-only", "--operation", operation], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe",
    })).not.toThrow();
  },
);
