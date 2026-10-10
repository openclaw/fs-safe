import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Root.copyIn metadata and literal links", () => {
  it.each(["off", process.env.FS_SAFE_NATIVE_MODE === "require" ? "require" : "auto"])(
    "proves real main-thread and Worker operations with native %s", async mode => {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./fixtures/root-copy-metadata-links.mjs", import.meta.url)), mode,
      ], { timeout: 30_000 });
      expect(stderr).toBe("");
      expect(stdout).toContain('"thread":"main"');
      expect(stdout).toContain('"thread":"worker"');
      console.log(stdout.trim());
    }, 35_000,
  );
});
