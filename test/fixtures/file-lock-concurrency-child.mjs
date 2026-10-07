import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";

const [targetPath, logPath, index] = process.argv.slice(2);
const owner = `${process.pid}:${index}`;
const lock = await acquireFileLock(targetPath, {
  staleMs: 60_000,
  timeoutMs: 10_000,
  retry: { minTimeout: 1, maxTimeout: 5 },
  payload: async () => ({ owner, createdAt: new Date().toISOString() }),
});
try {
  await fs.appendFile(logPath, `enter ${owner}\n`);
  await delay(20);
  await fs.appendFile(logPath, `exit ${owner}\n`);
} finally {
  await lock.release();
}
assert.ok((await fs.readFile(logPath, "utf8")).includes(owner));
