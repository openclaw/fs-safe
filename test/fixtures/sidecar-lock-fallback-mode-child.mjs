import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";

const directory = process.argv[2];
const umask = Number(process.argv[3]);
process.umask(umask);
configureFsSafeNative({ mode: "off" });

const targetPath = path.join(directory, "state.json");
const lock = await acquireFileLock(targetPath, {
  managerKey: `isolated-umask-${umask}`,
  payload: () => ({ owner: "child" }),
});
const mode = (await fs.lstat(lock.lockPath)).mode & 0o777;
const held = await lock.verifyStillHeld();
await lock.release();
const absent = await fs.lstat(lock.lockPath).then(
  () => false,
  (error) => error?.code === "ENOENT",
);
console.log(JSON.stringify({ mode, held, absent }));
