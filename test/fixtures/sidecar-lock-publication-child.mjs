import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Bun can execute the unchanged source tree for the red-main proof.
const location = process.env.FS_SAFE_CRASH_SOURCE === "1" ? "../../src/" : "../../dist/";
const { acquireFileLock, acquireFileLockSync } = await import(`${location}file-lock.js`);
const { root } = await import(`${location}root.js`);
const { configureFsSafeNative } = await import(`${location}config.js`);
const { __setFsSafeTestHooksForTest } = await import(`${location}test-hooks.js`);
const [directory, kind, mode] = process.argv.slice(2);
configureFsSafeNative({ mode });
const target = path.join(directory, "state"), lockPath = `${target}.lock`;
const stdout = fs.writeSync.bind(fs);
const suspend = (final, temporary) => {
  stdout(1, `${JSON.stringify({ final, temporary, pid: process.pid })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const beforeWrite = () => {
  if (fs.existsSync(lockPath)) suspend(lockPath, lockPath);
};
// The old implementation has no publication hook: catch its empty final lock
// immediately before payload persistence instead, at the same crash boundary.
for (const method of ["writeSync", "write", "writeFileSync"]) {
  const original = fs[method];
  fs[method] = (...args) => { beforeWrite(); return Reflect.apply(original, fs, args); };
}
const open = fsp.open;
fsp.open = async (...args) => {
  const handle = await Reflect.apply(open, fsp, args);
  for (const method of ["write", "writeFile"]) {
    const original = handle[method];
    handle[method] = (...values) => { beforeWrite(); return Reflect.apply(original, handle, values); };
  }
  return handle;
};
__setFsSafeTestHooksForTest({ beforeSidecarLockPublish: suspend });
const options = {
  payload: () => ({ pid: process.pid, owner: "child" }), timeoutMs: 0,
  retry: { retries: 0 }, staleMs: Infinity,
  ...(kind.startsWith("root") ? { lockRoot: await root(directory) } : {}),
};
if (kind.endsWith("async")) await acquireFileLock(target, options);
else acquireFileLockSync(target, options);
throw new Error("crash injection was not reached");
