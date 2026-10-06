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
  throw new Error("Linux no-replace tests require the built host addon");
}

describe.skipIf(!available)("Linux without renameat2 RENAME_NOREPLACE", () => {
  it.each(["linkat", "unlinkat"])("reports the public partial state when %s is denied", fault => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fs-safe-move-seccomp-"));
    try {
      const wrapper = path.join(directory, "deny-noreplace");
      const cc = spawnSync("cc", [fileURLToPath(new URL("./fixtures/deny-rename-noreplace.c", import.meta.url)), "-o", wrapper], { encoding: "utf8" });
      expect(cc.status, cc.stderr).toBe(0);
      const child = spawnSync(wrapper, [`EINVAL-${fault}`, process.execPath,
        fileURLToPath(new URL("./fixtures/linux-move-partial.mjs", import.meta.url)), artifact!, fault,
      ], { env: { ...process.env, FS_SAFE_NATIVE_MODE: "auto" }, encoding: "utf8", timeout: 20_000 });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain("move fallback partial state: passed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(["EINVAL", "ENOSYS"])("handles seccomp %s in auto and require mode", errno => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fs-safe-seccomp-"));
    try {
      const wrapper = path.join(directory, "deny-noreplace");
      const cc = spawnSync("cc", [fileURLToPath(new URL("./fixtures/deny-rename-noreplace.c", import.meta.url)), "-o", wrapper], { encoding: "utf8" });
      expect(cc.status, cc.stderr).toBe(0);
      for (const mode of ["auto", "require"]) {
        const child = spawnSync(wrapper, [errno, process.execPath,
          fileURLToPath(new URL("./fixtures/linux-noreplace-fallback.mjs", import.meta.url)), artifact!,
        ], { env: { ...process.env, FS_SAFE_NATIVE_MODE: mode }, encoding: "utf8", timeout: 20_000 });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.signal, child.stderr).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        expect(child.stdout).toContain("renameat2 fallback: passed");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
