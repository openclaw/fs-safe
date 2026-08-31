import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

async function prove() {
  const { configureFsSafeNative } = await import("../dist/config.js");
  const { tempWorkspace, tempWorkspaceSync } = await import("../dist/temp.js");
  const { __setFsSafeTestHooksForTest } = await import("../dist/test-hooks.js");
  configureFsSafeNative({ mode: "require" });

  async function runCase(variant, reparseRoot = false) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-quarantine-proof-"));
    let workspace;
    try {
      const outside = path.join(rootDir, "outside");
      if (reparseRoot) {
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "keep.txt"), "outside");
      }
      const options = { rootDir, prefix: variant, cleanupSafety: "require-bounded" };
      workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
      await fs.mkdir(path.join(workspace.dir, "nested"));
      await fs.writeFile(path.join(workspace.dir, "nested", "owned.txt"), "owned");

      let hookCalls = 0;
      let quarantine;
      __setFsSafeTestHooksForTest(variant === "async" ? {
        async beforeTempWorkspaceNativeRemoval(candidate) {
          hookCalls += 1;
          assert.equal(hookCalls, 1, "async removal hook ran more than once");
          quarantine = candidate;
          await fs.rename(quarantine, `${quarantine}.owned`);
          if (reparseRoot) {
            await fs.symlink(outside, quarantine, process.platform === "win32" ? "junction" : "dir");
          } else {
            await fs.mkdir(path.join(quarantine, "nested"), { recursive: true });
            await fs.writeFile(path.join(quarantine, "nested", "keep.txt"), "replacement");
          }
        },
      } : {
        beforeTempWorkspaceNativeRemovalSync(candidate) {
          hookCalls += 1;
          assert.equal(hookCalls, 1, "sync removal hook ran more than once");
          quarantine = candidate;
          fsSync.renameSync(quarantine, `${quarantine}.owned`);
          if (reparseRoot) {
            fsSync.symlinkSync(outside, quarantine, process.platform === "win32" ? "junction" : "dir");
          } else {
            fsSync.mkdirSync(path.join(quarantine, "nested"), { recursive: true });
            fsSync.writeFileSync(path.join(quarantine, "nested", "keep.txt"), "replacement");
          }
        },
      });

      const result = await workspace.cleanup();
      const repeatedResult = await workspace.cleanup();
      assert.equal(hookCalls, 1, `${variant} removal hook must run exactly once`);
      assert.equal(result, "indeterminate", `${variant} cleanup result mismatch`);
      assert.equal(repeatedResult, "indeterminate", `${variant} repeated cleanup result mismatch`);
      const publicExists = await fs.lstat(workspace.dir).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      assert.equal(publicExists, false, `${variant} public workspace still exists`);
      const original = await fs.readFile(path.join(`${quarantine}.owned`, "nested", "owned.txt"), "utf8");
      assert.equal(original, "owned", `${variant} original owned bytes changed`);
      if (reparseRoot) {
        const reparsePreserved = (await fs.lstat(quarantine)).isSymbolicLink();
        assert.equal(reparsePreserved, true, `${variant} quarantine reparse entry was not preserved`);
        const outsideBytes = await fs.readFile(path.join(outside, "keep.txt"));
        assert.deepEqual(outsideBytes, Buffer.from("outside"), `${variant} outside bytes changed`);
        return {
          hookCalls, result, repeatedResult, publicExists, reparsePreserved,
          outside: outsideBytes.toString("utf8"), original,
        };
      }
      const replacement = await fs.readFile(path.join(quarantine, "nested", "keep.txt"), "utf8");
      assert.equal(replacement, "replacement", `${variant} replacement bytes changed`);
      return { hookCalls, result, repeatedResult, publicExists, replacement, original };
    } finally {
      __setFsSafeTestHooksForTest();
      try {
        if (workspace) await workspace.cleanup();
      } finally {
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    }
  }

  const asyncProof = await runCase("async");
  const syncProof = await runCase("sync");
  const reparseRoot = {
    async: await runCase("async", true),
    sync: await runCase("sync", true),
  };
  console.log(JSON.stringify({
    proof: "temp-workspace-quarantine-swap",
    platform: process.platform,
    async: asyncProof,
    sync: syncProof,
    reparseRoot,
  }));
}

try {
  await prove();
} catch (error) {
  // Native and filesystem error messages can contain private absolute paths.
  const reason = error instanceof assert.AssertionError ? error.message : error?.code ?? error?.name;
  console.error(`temp-workspace-quarantine-swap proof failed: ${reason ?? "unknown error"}`);
  process.exitCode = 1;
}
