import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tryAcquireWriteLease } from "../src/file-lock.js";
import { inspectDarwinAcl } from "../src/permissions-public.js";
import { holdWindowsSharingLock, setWindowsFileAttributes, readWindowsFileExtents } from "../src/test-hooks.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useTempDirs } from "./helpers/vitest.js";

const native = loadTestNative("required-env");
const { tempRoot } = useTempDirs();

describe("platform capability contracts", () => {
  it("keeps platform results explicit", () => {
    if (process.platform !== "linux") expect(() => tryAcquireWriteLease(0)).toThrowError(expect.objectContaining({ code: "unsupported-platform" }));
    if (process.platform !== "darwin") expect(inspectDarwinAcl("missing")).toEqual({ kind: "unknown", reason: "unsupported-platform" });
    if (process.platform !== "win32") {
      for (const operation of [() => holdWindowsSharingLock("missing"), () => setWindowsFileAttributes("missing", {}), () => readWindowsFileExtents("missing")]) {
        expect(operation).toThrowError(expect.objectContaining({ code: "unsupported-platform" }));
      }
    }
    expect(true).toBe(true);
  });
});

describe.runIf(Boolean(native) && process.env.FS_SAFE_NATIVE_MODE !== "off")("real platform capabilities", () => {
  it.each(["main", "worker"])("proves native behavior in %s thread", async mode => {
    const directory = await tempRoot(`fs-safe-capabilities-${mode}-`);
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./fixtures/platform-capabilities.mjs", import.meta.url)),
      mode, directory,
    ], { timeout: 20_000, env: { ...process.env, FS_SAFE_NATIVE_MODE: "require" } });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`"mode":"${mode}"`);
    console.log(result.stdout.trim());
  }, 25_000);
});
