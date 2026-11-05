import fs from "node:fs";
import path from "node:path";
import { acquireFileLock, acquireFileLockSync } from "../../dist/file-lock.js";
import { root } from "../../dist/root.js";
import { configureFsSafeNative } from "../../dist/config.js";
import { __setFsSafeTestHooksForTest } from "../../dist/test-hooks.js";

const [directory, kind, mode] = process.argv.slice(2);
configureFsSafeNative({ mode });
const target = path.join(directory, "state");
__setFsSafeTestHooksForTest({ beforeSidecarLockPublish(final, temporary) {
  fs.writeSync(1, `${JSON.stringify({ final, temporary, pid: process.pid })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} });
const options = {
  payload: () => ({ pid: process.pid, owner: "child" }), timeoutMs: 0,
  retry: { retries: 0 }, staleMs: Infinity,
  ...(kind.startsWith("root") ? { lockRoot: await root(directory) } : {}),
};
if (kind.endsWith("async")) await acquireFileLock(target, options);
else acquireFileLockSync(target, options);
throw new Error("crash injection was not reached");
