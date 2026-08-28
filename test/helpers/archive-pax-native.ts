import { createRequire } from "node:module";
import { hostNativeTarget } from "../../scripts/native-targets.mjs";
import type { NativeBinding } from "../../src/native.js";

// pnpm check rebuilds dist, removing its staged binding. Load the actual host
// build artifact here so the PAX proof still executes Rust during that check.
function loadNative(): NativeBinding | undefined {
  try {
    const target = hostNativeTarget();
    if (!target) throw new Error("no native target for PAX tests");
    return createRequire(import.meta.url)(`../../native/${target.artifact}`) as NativeBinding;
  } catch (error) {
    if (process.env.FS_SAFE_PAX_REQUIRE_NATIVE === "1") throw error;
    return undefined; // Like the existing native suite, JS-only CI can omit Rust.
  }
}

export const paxNative = loadNative();
