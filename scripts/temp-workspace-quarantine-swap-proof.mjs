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
  const { getNativeBinding, __setNativeLoaderForTest, __resetNativeLoaderForTest } = await import("../dist/native.js");
  configureFsSafeNative({ mode: "require" });
  const binding = getNativeBinding();
  assert.equal(typeof binding.tryRemoveEmptyOwnedTree, "function", "new native empty-removal binding required");

  async function runEmptyCase(variant, replacement) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-empty-quarantine-proof-"));
    const outside = path.join(rootDir, "outside");
    const originalBytes = Buffer.from([0x6f, 0x77, 0x6e, 0x65, 0x64, 0x00, 0xff]);
    const outsideBytes = Buffer.from([0x6b, 0x65, 0x65, 0x70, 0x00, 0xfe]);
    let workspace;
    let quarantine;
    let emptyCalls = 0;
    let recursiveCalls = 0;
    let hookCalls = 0;
    __setNativeLoaderForTest(() => ({
      ...binding,
      tryRemoveEmptyOwnedTree: (...args) => {
        emptyCalls += 1;
        return binding.tryRemoveEmptyOwnedTree(...args);
      },
      removeOwnedTree: (...args) => { recursiveCalls += 1; return binding.removeOwnedTree(...args); },
      removeOwnedTreeSync: (...args) => { recursiveCalls += 1; return binding.removeOwnedTreeSync(...args); },
    }));
    try {
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "keep"), outsideBytes);
      const options = { rootDir, prefix: variant, cleanupSafety: "require-bounded" };
      workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
      assert.deepEqual(await fs.readdir(workspace.dir), []);
      const beforeRemoval = (candidate) => {
        hookCalls += 1;
        quarantine = candidate;
        if (replacement === "none") return;
        // Add owned bytes only after cleanup captured its empty-attempt hint.
        fsSync.writeFileSync(path.join(quarantine, "owned"), originalBytes);
        fsSync.renameSync(quarantine, `${quarantine}.owned`);
        if (replacement === "reparse") {
          fsSync.symlinkSync(outside, quarantine, process.platform === "win32" ? "junction" : "dir");
        } else {
          fsSync.mkdirSync(quarantine);
          fsSync.writeFileSync(path.join(quarantine, "keep"), outsideBytes);
        }
      };
      __setFsSafeTestHooksForTest(variant === "async"
        ? { beforeTempWorkspaceNativeRemoval: beforeRemoval }
        : { beforeTempWorkspaceNativeRemovalSync: beforeRemoval });
      const result = await workspace.cleanup();
      const repeated = await workspace.cleanup();
      assert.equal(hookCalls, 1);
      assert.equal(emptyCalls, 1, "proof must select the real new native empty-removal route");
      assert.equal(recursiveCalls, 0, "replacement must not enter recursive removal");
      assert.equal(fsSync.existsSync(workspace.dir), false);
      assert.equal(result, replacement === "none" ? "removed" : "indeterminate");
      assert.equal(repeated, replacement === "none" ? "missing" : "indeterminate");
      assert.deepEqual(await fs.readFile(path.join(outside, "keep")), outsideBytes);
      if (replacement !== "none") {
        assert.deepEqual(await fs.readFile(path.join(`${quarantine}.owned`, "owned")), originalBytes);
        assert.deepEqual(await fs.readFile(path.join(quarantine, "keep")), outsideBytes);
        assert.equal((await fs.lstat(quarantine)).isSymbolicLink(), replacement === "reparse");
      }
      return { variant, replacement, result, repeated, emptyCalls, recursiveCalls,
        outsidePreserved: true, originalPreserved: replacement !== "none", publicNameAbsent: true };
    } finally {
      __setFsSafeTestHooksForTest();
      __resetNativeLoaderForTest();
      try { if (workspace) await workspace.cleanup(); }
      finally { await fs.rm(rootDir, { recursive: true, force: true }); }
    }
  }

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
  const emptyRoute = [];
  for (const variant of ["async", "sync"]) {
    for (const replacement of ["none", "directory", "reparse"]) {
      emptyRoute.push(await runEmptyCase(variant, replacement));
    }
  }
  console.log(JSON.stringify({
    proof: "temp-workspace-quarantine-swap",
    platform: process.platform,
    async: asyncProof,
    sync: syncProof,
    reparseRoot,
    emptyRoute,
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
