import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hostNativeTarget } from "../scripts/native-targets.mjs";

const target = hostNativeTarget();
const artifact = target && fileURLToPath(new URL(`../native/${target.artifact}`, import.meta.url));
it.skipIf(!artifact || !existsSync(artifact) || process.platform === "win32" || process.platform === "freebsd")
  .each(["create", "renameReplace", "renameNoReplace"])("keeps the JS timer responsive during queued native %s", operation => {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL("./fixtures/native-staged-file-responsive.cjs", import.meta.url)), artifact!, operation,
    ], { encoding: "utf8", env: { ...process.env, UV_THREADPOOL_SIZE: "1" }, timeout: 15_000 });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
  }, 20_000);
