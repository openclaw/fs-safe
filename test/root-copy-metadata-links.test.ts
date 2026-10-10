import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Root.copyIn metadata and literal links", () => {
  it("proves auto behavior from a JavaScript-only package without an addon", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copy-without-native-"));
    try {
      await fs.cp(fileURLToPath(new URL("../dist", import.meta.url)), path.join(directory, "dist"), { recursive: true });
      const fixtures = path.join(directory, "test", "fixtures");
      await fs.mkdir(fixtures, { recursive: true });
      const script = path.join(fixtures, "root-copy-metadata-links.mjs");
      await fs.copyFile(fileURLToPath(new URL("./fixtures/root-copy-metadata-links.mjs", import.meta.url)), script);
      await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, "auto"], { timeout: 30_000 });
      expect(stderr).toBe("");
      expect(stdout).toContain('"thread":"main"');
      expect(stdout).toContain('"thread":"worker"');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 35_000);
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
