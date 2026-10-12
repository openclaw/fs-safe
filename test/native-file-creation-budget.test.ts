import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI supplies the binding. */ }
const cases = ["appendCreate", "openWritableCreate"].flatMap(operation =>
  [0, 1, 8].map(depth => ({ operation, depth })));

describe.runIf(native?.openCreateBeneath && !process.versions.bun)("native file creation budgets", () => {
  it.each(cases)("pins $operation resources at parent depth $depth", ({ operation, depth }) => {
    expect(() => execFileSync(process.execPath, ["scripts/native-call-budget-proof.mjs", "--operation", operation,
      "--creation-depth", String(depth),
      ...(process.env.FS_SAFE_UPDATE_NATIVE_BUDGETS === "1" ? ["--update"] : []),
      ...(process.env.FS_SAFE_NATIVE_SYSCALL_BUDGETS === "1" ? [] : ["--resources-only"])], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe",
    })).not.toThrow();
  }, 20_000);
});
