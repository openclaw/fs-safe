import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.runIf(process.platform === "win32" && Boolean(process.env.FS_SAFE_CLONE_TEST_ROOT))(
  "Root.copyIn real ReFS",
  () => {
    it.each(["main", "worker"])("proves guarded block cloning in %s", async mode => {
      const result = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./fixtures/root-copy-refs.mjs", import.meta.url)), mode,
      ], { timeout: 30_000, env: { ...process.env, FS_SAFE_NATIVE_MODE: "require" } });
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`"mode":"${mode}"`);
      console.log(result.stdout.trim());
    }, 35_000);
  },
);
