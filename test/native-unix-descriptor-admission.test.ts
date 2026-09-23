import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostNativeTarget } from "../scripts/native-targets.mjs";

const unix = process.platform === "linux" || process.platform === "darwin";
const target = unix ? hostNativeTarget() : undefined;
const artifact = target
  ? fileURLToPath(new URL(`../native/${target.artifact}`, import.meta.url))
  : undefined;
const available = artifact !== undefined && existsSync(artifact);
const required = process.env.FS_SAFE_NATIVE_MODE === "require" ||
  process.env.FS_SAFE_PAX_REQUIRE_NATIVE === "1";

if (unix && required && !available) {
  throw new Error("Native descriptor admission tests require the built host addon");
}

const methods = [
  "fstatIdentity", "probeTreeClone", "mkdirChildBeneath", "createStagedFile",
  "stagedFileMatches", "removeStagedFile", "removeOwnedTree", "removeOwnedTreeSync",
  "sha256File", "cloneFileExclusive", "cloneTree", "openBeneath", "extractArchiveNative",
  ...(process.platform === "linux" ? ["copyFileRangeExclusive", "copyFileContents"] : []),
];

describe.skipIf(!unix || !available)("native Unix descriptor admission", () => {
  it.each(methods)("rejects negative descriptors through %s without losing ownership", method => {
    // An accidental Rust panic stays in a bounded child and cannot leave a core dump.
    const child = spawnSync("/bin/sh", [
      "-c", 'ulimit -c 0; exec "$@"', "fs-safe-descriptor-admission", process.execPath,
      fileURLToPath(new URL("./fixtures/native-unix-descriptor-admission.cjs", import.meta.url)),
      artifact!, method,
    ], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim(), child.stderr).toBe(`${method}: passed`);
  }, 20_000);
});
