import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __loadBundledNativeForTest } from "../src/native.js";

let nativeAvailable = false;
try { __loadBundledNativeForTest(); nativeAvailable = true; } catch { /* JS-only lanes omit the addon. */ }
const supported = process.platform === "linux" || process.platform === "darwin";

describe.runIf(supported && (nativeAvailable || process.env.FS_SAFE_NATIVE_MODE === "require"))(
  "native writes under the process descriptor limit", () => {
    it("reports EMFILE and preserved stages without changing uncertain-publication cleanup", () => {
      expect(nativeAvailable).toBe(true);
      const result = spawnSync("/bin/sh", ["-c", 'ulimit -n 64; exec "$1" "$2"', "fs-safe-descriptor-test",
        process.execPath, fileURLToPath(new URL("./fixtures/native-write-descriptor-limit.mjs", import.meta.url)),
      ], { encoding: "utf8", timeout: 30_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const rows = JSON.parse(result.stdout);
      const preserved = rows.filter((row: { files: string[] }) => row.files.some(name => name.startsWith(".fs-safe-")));
      expect(preserved.length).toBeGreaterThan(0);
      for (const row of preserved) {
        expect(row.failure).toMatchObject({
          code: "helper-failed", category: "operational",
          message: expect.stringContaining("EMFILE"),
          details: { publication: { status: "indeterminate" }, cleanup: { status: "preserved", resources: "closed" } },
          cause: { name: "SuppressedError", suppressed: { cause: { code: "EMFILE" } } },
        });
        expect(row.failure.message).toContain("staged file preserved");
        expect(row.failure.message).not.toContain("not a regular file");
        expect(row.contents).toEqual(["complete contents"]);
      }
      expect(rows.some((row: { failure?: unknown; files: string[] }) => !row.failure && row.files.includes("output"))).toBe(true);
      console.log(JSON.stringify(preserved.map((row: { spare: number; failure: unknown }) => ({ spare: row.spare, failure: row.failure }))));
    });
  },
);
