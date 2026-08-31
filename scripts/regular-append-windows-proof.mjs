import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
const { appendRegularFile, appendRegularFileSync } = await import("../dist/advanced.js");
const { __setFsSafeTestHooksForTest } = await import("../dist/test-hooks.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-append-proof-"));
try {
  const asyncPath = path.join(root, "async");
  const asyncOld = path.join(root, "async.old");
  await fs.writeFile(asyncPath, "original");
  let asyncHookRan = false;
  __setFsSafeTestHooksForTest({
    async beforeRegularFileAppendOpen(candidate) {
      if (candidate !== asyncPath) return;
      asyncHookRan = true;
      await fs.rename(asyncPath, asyncOld);
      await fs.writeFile(asyncPath, "replacement");
    },
  });
  let asyncError;
  try {
    await appendRegularFile({ filePath: asyncPath, content: "x" });
  } catch (error) {
    asyncError = { name: error?.name, code: error?.code, message: error?.message };
  } finally {
    __setFsSafeTestHooksForTest();
  }
  if (!asyncHookRan) throw new Error("async append rejected before the timing hook ran");
  if (!asyncError?.message?.includes("Refusing to append after file changed")) {
    throw new Error(`async append returned the wrong race error: ${asyncError?.message}`);
  }
  const asyncCurrent = await fs.readFile(asyncPath, "utf8");
  const asyncOriginal = await fs.readFile(asyncOld, "utf8");
  if (asyncCurrent !== "replacement" || asyncOriginal !== "original") {
    throw new Error("async append mutated raced files");
  }

  const syncPath = path.join(root, "sync");
  const syncOld = path.join(root, "sync.old");
  fsSync.writeFileSync(syncPath, "original");
  let syncHookRan = false;
  __setFsSafeTestHooksForTest({
    beforeRegularFileAppendOpenSync(candidate) {
      if (candidate !== syncPath) return;
      syncHookRan = true;
      fsSync.renameSync(syncPath, syncOld);
      fsSync.writeFileSync(syncPath, "replacement");
    },
  });
  let syncError;
  try {
    appendRegularFileSync({ filePath: syncPath, content: "x" });
  } catch (error) {
    syncError = { name: error?.name, code: error?.code, message: error?.message };
  } finally {
    __setFsSafeTestHooksForTest();
  }
  if (!syncHookRan) throw new Error("sync append rejected before the timing hook ran");
  if (!syncError?.message?.includes("Refusing to append after file changed")) {
    throw new Error(`sync append returned the wrong race error: ${syncError?.message}`);
  }
  const syncCurrent = fsSync.readFileSync(syncPath, "utf8");
  const syncOriginal = fsSync.readFileSync(syncOld, "utf8");
  if (syncCurrent !== "replacement" || syncOriginal !== "original") {
    throw new Error("sync append mutated raced files");
  }

  const stableAsyncPath = path.join(root, "stable-async");
  await fs.writeFile(stableAsyncPath, "a");
  await appendRegularFile({ filePath: stableAsyncPath, content: "b" });
  const stableAsync = await fs.readFile(stableAsyncPath, "utf8");
  if (stableAsync !== "ab") throw new Error("stable async append did not write expected bytes");

  const stableSyncPath = path.join(root, "stable-sync");
  fsSync.writeFileSync(stableSyncPath, "a");
  appendRegularFileSync({ filePath: stableSyncPath, content: "b" });
  const stableSync = fsSync.readFileSync(stableSyncPath, "utf8");
  if (stableSync !== "ab") throw new Error("stable sync append did not write expected bytes");

  console.log(JSON.stringify({
    proof: "regular-append-production-api",
    platform: process.platform,
    async: { hookRan: asyncHookRan, error: asyncError, current: asyncCurrent, original: asyncOriginal },
    sync: { hookRan: syncHookRan, error: syncError, current: syncCurrent, original: syncOriginal },
    stable: { async: stableAsync, sync: stableSync },
  }));
} finally {
  __setFsSafeTestHooksForTest();
  await fs.rm(root, { recursive: true, force: true });
}
