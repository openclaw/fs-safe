import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostNativeTarget } from "../scripts/native-targets.mjs";

const target = process.platform === "linux" ? hostNativeTarget() : undefined;
const artifact = target && fileURLToPath(new URL(`../native/${target.artifact}`, import.meta.url));
const available = artifact !== undefined && existsSync(artifact);
if (process.platform === "linux" && process.env.FS_SAFE_NATIVE_MODE === "require" && !available) {
  throw new Error("Linux openat2 parity tests require the built host addon");
}

describe.skipIf(!available)("Linux beneath mechanism parity", () => {
  it("preserves operations, final flags, confinement and policy precedence", () => {
    function run(fallback: boolean, filter?: string) {
      const args = [fileURLToPath(new URL("./fixtures/linux-openat2-parity.mjs", import.meta.url)), artifact!];
      const child = spawnSync(filter ?? process.execPath, filter ? ["ENOSYS", process.execPath, ...args] : args, {
        env: { ...process.env, FS_SAFE_NATIVE_MODE: "require", FS_SAFE_TEST_NO_OPENAT2: fallback ? "1" : "0" },
        encoding: "utf8", timeout: 30_000,
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.signal, child.stderr).toBeNull();
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout) as { containment: string; results: Record<string, string> };
    }
    const normal = run(false);
    const fallback = run(true);
    expect(fallback.containment).toBe("best-effort");
    expect(fallback.results).toEqual(normal.results);
    const filter = process.env.FS_SAFE_TEST_OPENAT2_FILTER;
    if (filter) {
      // The baseline stays outside seccomp; only this child installs the real
      // ENOSYS filter, with the environment override explicitly disabled.
      expect(normal.containment).toBe("kernel-atomic");
      const seccomp = run(false, filter);
      expect(seccomp.containment).toBe("best-effort");
      expect(seccomp.results).toEqual(normal.results);
    }
  }, 90_000);
});
