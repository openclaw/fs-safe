import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-legacy-exit-proof-"));
const fileLockUrl = new URL("../dist/file-lock.js", import.meta.url);
try {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { createFileLockManager } from ${JSON.stringify(fileLockUrl.href)};
    const directory = process.argv[1];
    const options = { payload: () => ({ owner: "synthetic-proof" }) };
    const legacy = createFileLockManager("legacy-proof");
    const first = await legacy.acquire(path.join(directory, "legacy"), options);
    assert.equal(await first.verifyStillHeld(), true);
    // Reproduce the shared manager shape left by an older package copy.
    const state = globalThis[Symbol.for("fsSafe.sidecarLockManagers")].get("legacy-proof");
    delete state.reclaimGuards;
    delete state.reclaimCleanupRegistered;
    const modern = createFileLockManager("modern-proof");
    const second = await modern.acquire(path.join(directory, "modern"), options);
    assert.equal(await second.verifyStillHeld(), true);
    await modern.acquire(path.join(directory, "retained"), { ...options, retainOnExit: true });
    process.exit(0);
  `, directory], { encoding: "utf8", timeout: 10_000 });
  const result = {
    exitCode: child.status,
    legacyLockRemoved: !fs.existsSync(path.join(directory, "legacy.lock")),
    modernLockRemoved: !fs.existsSync(path.join(directory, "modern.lock")),
    retainedLockPreserved: fs.existsSync(path.join(directory, "retained.lock")),
  };
  console.log(JSON.stringify(result));
  assert.ifError(child.error);
  assert.equal(child.stderr, "");
  assert.deepEqual(result, {
    exitCode: 0,
    legacyLockRemoved: true,
    modernLockRemoved: true,
    retainedLockPreserved: true,
  });
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
