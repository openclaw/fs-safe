import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostNativeTarget } from "../scripts/native-targets.mjs";

const target = process.platform === "linux" ? hostNativeTarget() : undefined;
const artifact = target && fileURLToPath(new URL(`../native/${target.artifact}`, import.meta.url));
const available = artifact !== undefined && existsSync(artifact);
if (process.platform === "linux" && process.env.FS_SAFE_NATIVE_MODE === "require" && !available) {
  throw new Error("Linux openat2 fallback tests require the built host addon");
}

describe.skipIf(!available)("Linux without openat2", () => {
  it("keeps native operations and boundaries with the cached fallback", () => {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/linux-openat2-fallback.mjs", import.meta.url)), artifact!,
    ], {
      env: { ...process.env, FS_SAFE_NATIVE_MODE: "require", FS_SAFE_TEST_NO_OPENAT2: "1" },
      encoding: "utf8", timeout: 20_000,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("openat2 fallback: passed");
  });
});
