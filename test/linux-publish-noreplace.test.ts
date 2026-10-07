import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostNativeTarget } from "../scripts/native-targets.mjs";

const target = process.platform === "linux" ? hostNativeTarget() : undefined;
const artifact = target && fileURLToPath(new URL(`../native/${target.artifact}`, import.meta.url));
const available = artifact !== undefined && existsSync(artifact);
if (process.platform === "linux" && process.env.FS_SAFE_NATIVE_MODE === "require" && !available) {
  throw new Error("Linux publication tests require the built host addon");
}

describe.skipIf(!available)("publication without renameat2 RENAME_NOREPLACE", () => {
  it.each(["auto", "require", "collision", "source-swap", "linkat", "unlinkat"])("preserves the %s contract", scenario => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fs-safe-publish-seccomp-"));
    try {
      const wrapper = path.join(directory, "deny-noreplace");
      const cc = spawnSync("cc", [fileURLToPath(new URL("./fixtures/deny-rename-noreplace.c", import.meta.url)), "-o", wrapper], { encoding: "utf8" });
      expect(cc.status, cc.stderr).toBe(0);
      const fault = scenario === "linkat" || scenario === "unlinkat" ? `EINVAL-${scenario}` : "EINVAL";
      const child = spawnSync(wrapper, [fault, process.execPath,
        fileURLToPath(new URL("./fixtures/linux-publish-noreplace.mjs", import.meta.url)), artifact!, scenario, path.join(directory, "files"),
      ], { env: { ...process.env, FS_SAFE_NATIVE_MODE: scenario === "require" ? "require" : "auto" }, encoding: "utf8", timeout: 20_000 });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain("publication fallback: passed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
