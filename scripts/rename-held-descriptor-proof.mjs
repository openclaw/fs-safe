// After pnpm build, run on the affected mount:
// node scripts/rename-held-descriptor-proof.mjs /path/to/trusted/existing/parent
// Uses only a new child directory; the parent must be trusted and quiescent.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic, replaceFileAtomicSync, writeTextAtomic } from "../dist/atomic.js";
import { root } from "../dist/root.js";
import { configureFsSafeNative } from "../dist/native-config.js";
import { admitsDrvfsRenameRecoveryAtFd } from "../dist/publication-recovery.js";
const openPublicationPin = fd => fs.openSync(`/proc/self/fd/${fd}`, 0x200000);

assert.equal(process.argv.length, 3, "Pass an existing trusted parent on the affected mount");
const parent = await fsp.realpath(process.argv[2]);
const directory = await fsp.mkdtemp(path.join(parent, "fs-safe-held-rename-"));
const identity = await fsp.lstat(directory, { bigint: true });
const report = { node: process.version, platform: process.platform, plain: {}, cases: [] };
const observe = (operation) => {
  try { operation(); return "ok"; } catch (error) { return error.code ?? error.name; }
};
try {
  const from = path.join(directory, "plain.tmp");
  const to = path.join(directory, "plain.txt");
  const fd = fs.openSync(from, "wx", 0o600);
  let before;
  let pin;
  try {
    fs.writeFileSync(fd, "plain");
    before = fs.fstatSync(fd, { bigint: true });
    fs.renameSync(from, to);
    report.plain = {
      fstat: observe(() => fs.fstatSync(fd)),
      stat: observe(() => fs.statSync(to)),
      lstat: observe(() => fs.lstatSync(to)),
      open: observe(() => fs.closeSync(fs.openSync(to, "r"))),
      listed: fs.readdirSync(directory).includes("plain.txt"),
    };
    report.plain.pinOpen = observe(() => { pin = openPublicationPin(fd); });
  } finally { fs.closeSync(fd); }
  try {
    report.plain.statWhilePinned = observe(() => fs.statSync(to));
    if (pin !== undefined) report.plain.pinStat = observe(() => {
      const retained = fs.fstatSync(pin, { bigint: true });
      report.plain.pinRetainsIdentity = retained.dev === before.dev && retained.ino === before.ino;
    });
  } finally { if (pin !== undefined) fs.closeSync(pin); }
  const after = fs.statSync(to, { bigint: true });
  report.plain.sameIdentityAfterClose = before.dev === after.dev && before.ino === after.ino;

  const parentFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { report.verifiedDrvfs = admitsDrvfsRenameRecoveryAtFd(parentFd); } finally { fs.closeSync(parentFd); }
  for (const [name, write] of [
    ["atomic-async", filePath => replaceFileAtomic({ filePath, content: "payload", allowDrvfsRenameRecovery: true, syncTempFile: true, syncParentDir: true })],
    ["atomic-sync", filePath => replaceFileAtomicSync({ filePath, content: "payload", allowDrvfsRenameRecovery: true, syncTempFile: true, syncParentDir: true })],
    ["text", filePath => writeTextAtomic(filePath, "payload", { allowDrvfsRenameRecovery: true })],
    ...["off", "require"].map(mode => [`root-${mode}`, async filePath => {
      configureFsSafeNative({ mode });
      await (await root(directory, { allowDrvfsRenameRecovery: true })).write(path.basename(filePath), "payload");
    }]),
  ]) {
    try {
      const filePath = path.join(directory, name);
      await write(filePath);
      assert.equal((await fsp.readFile(filePath, "utf8")).trim(), "payload");
      report.cases.push({ name, outcome: "ok" });
    } catch (error) {
      report.cases.push({ name, outcome: error.code ?? error.name });
      process.exitCode = 1;
    }
  }
} finally {
  // Refuse cleanup if the caller replaced the test directory itself.
  const current = await fsp.lstat(directory, { bigint: true });
  assert.equal(current.dev, identity.dev);
  assert.equal(current.ino, identity.ino);
  assert.equal(await fsp.realpath(directory), directory);
  await fsp.rm(directory, { recursive: true });
}
console.log(JSON.stringify(report, null, 2));
