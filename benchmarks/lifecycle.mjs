import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function registerLifecycle({ api: a, workspace: w, native, binding, register: add, contract, onCleanup }) {
  if (binding) {
    const directory = path.join(w, "native-directory");
    fs.mkdirSync(directory);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
    const rootFd = fs.openSync(w, flags);
    onCleanup(() => fs.closeSync(rootFd));
    add("native.openBeneath/directory", () => binding.openBeneath(rootFd, "native-directory", flags), {
      sync: true,
      verify: (opened) => assert.ok(fs.fstatSync(opened.fd).isDirectory()),
      after: (opened) => { if (opened) fs.closeSync(opened.fd); },
    });
  } else {
    add("native.openBeneath/directory", () => {}, { skip: "native binding unavailable" });
  }
  const input = path.join(w, "input.json");
  const data = Buffer.from("synthetic benchmark\n");
  const output = path.join(w, "lifecycle-output");
  const secretRoot = path.join(w, "secret-writes");
  fs.mkdirSync(secretRoot, { mode: 0o700 });
  for (const name of ["replaceFileAtomic", "replaceFileAtomicSync"]) add(name, () => a[name]({ filePath: output, content: data }), { sync: name.endsWith("Sync") });
  add("writeTextAtomic", () => a.writeTextAtomic(output, "synthetic benchmark"));
  add("replaceDirectoryAtomic", () => a.replaceDirectoryAtomic({ stagedDir: path.join(w, "staged-dir"), targetDir: path.join(w, "target-dir") }), { before: () => fs.mkdirSync(path.join(w, "staged-dir")), after: () => fs.rmSync(path.join(w, "target-dir"), { recursive: true, force: true }) });
  add("movePathWithCopyFallback", () => a.movePathWithCopyFallback({ from: path.join(w, "move-source"), to: output }), { before: () => fs.writeFileSync(path.join(w, "move-source"), data) });
  for (const name of ["writeSecretFileAtomic", "createSecretFileAtomic"]) add(name, () => a[name]({ rootDir: secretRoot, filePath: path.join(secretRoot, "secret-out"), content: data }), {
    before: () => name === "createSecretFileAtomic"
      ? fs.rmSync(path.join(secretRoot, "secret-out"), { force: true })
      : fs.writeFileSync(path.join(secretRoot, "secret-out"), data, { mode: 0o600 }),
  });
  add("writeExternalFileWithinRoot", () => a.writeExternalFileWithinRoot({ rootDir: w, path: "external-out", write: (p) => fsp.writeFile(p, data) }));
  add("writeSiblingTempFile", () => a.writeSiblingTempFile({ dir: w, writeTemp: (p) => fsp.writeFile(p, data), resolveFinalPath: () => output }));
  add("writeViaSiblingTempPath", () => a.writeViaSiblingTempPath({ rootDir: w, targetPath: output, writeTemp: (p) => fsp.writeFile(p, data) }));
  const tempOptions = { rootDir: w, prefix: "fixture" };
  add("resolveSecureTempRoot", () => a.resolveSecureTempRoot({ preferredDir: secretRoot, fallbackPrefix: "fs-safe-benchmark" }), { sync: true });
  for (const suffix of ["", "Sync"]) {
    const name = `tempWorkspace${suffix}`;
    const type = `TempWorkspace${suffix}`;
    const sync = suffix === "Sync";
    add(name, () => a[name](tempOptions), { sync, after: (r) => r?.cleanup() });
    add(`withTempWorkspace${suffix}`, () => a[`withTempWorkspace${suffix}`](tempOptions, sync ? () => 1 : async () => 1), { sync, before: () => {} });
    const tmp = await a[name](tempOptions);
    contract(type, tmp);
    onCleanup(() => tmp.cleanup());
    await tmp.write("input.json", data);
    for (const method of ["path", "read", "write", "writeText", "writeJson", ...(sync ? [] : ["copyIn"])]) {
      add(`${type}.${method}`, () => tmp[method](method === "read" || method === "path" ? "input.json" : "output.json", method === "writeJson" ? { ok: true } : method === "copyIn" ? input : data), { sync: sync || method === "path", before: method.startsWith("write") && sync ? () => {} : undefined });
    }
    add(`${type}.cleanup`, (r) => r.cleanup(), { sync, before: () => a[name](tempOptions) });
    const symbol = sync ? Symbol.dispose : Symbol.asyncDispose;
    add(`${type}.[${sync ? "Symbol.dispose" : "Symbol.asyncDispose"}]`, (r) => r[symbol](), { sync, before: () => a[name](tempOptions) });
    // The fixture is owned by the runner's temporary workspace.
  }
  const tmp = await a.tempFile(tempOptions);
  contract("TempFile", tmp);
  onCleanup(() => tmp.cleanup());
  add("tempFile", () => a.tempFile(tempOptions), { after: (r) => r?.cleanup() });
  add("TempFile.file", () => tmp.file("fixture"), { sync: true, batch: 100 });
  add("TempFile.cleanup", (r) => r.cleanup(), { before: () => a.tempFile(tempOptions) });
  add("TempFile.[Symbol.asyncDispose]", (r) => r[Symbol.asyncDispose](), { before: () => a.tempFile(tempOptions) });
  add("withTempFile", () => a.withTempFile(tempOptions, async () => 1));
  for (const name of ["syncDirectory", "syncDirectorySync", "syncDirectoryBestEffort", "syncDirectoryBestEffortSync"]) add(name, () => a[name](w), { sync: name.endsWith("Sync"), before: () => {}, divisor: 10 });
  add("ensureDurableDirectory", () => a.ensureDurableDirectory({ directoryPath: path.join(w, "durable-dir") }));
  add("pinDirectory", () => a.pinDirectory(w), { after: (r) => r?.close() });
  const pin = await a.pinDirectory(w);
  contract("PinnedDirectory", pin);
  await pin.close();
  for (const method of ["assertCurrent", "sync", "close"]) add(`PinnedDirectory.${method}`, (r) => r[method](), { before: () => a.pinDirectory(w), after: (_, r) => r.close() });
  for (const strategy of ["link-or-copy", "link-required", "rename-noreplace"]) {
    add(`publishFileExclusive/${strategy}`, () => a.publishFileExclusive({ sourcePath: path.join(w, "publish-source"), targetPath: path.join(w, "publish-target"), strategy }), {
      skip: strategy === "rename-noreplace" && !native ? "Native-only strategy." : undefined,
      before: () => fs.writeFileSync(path.join(w, "publish-source"), data), after: () => fs.rmSync(path.join(w, "publish-target"), { force: true }),
    });
  }
  const stagingSkip = !native || !["darwin", "linux"].includes(process.platform) ? "Retained-directory staging requires native Linux/macOS." : undefined;
  const stage = () => a.stageFileInDirectory({ directory: w, content: data });
  add("stageFileInDirectory", stage, { skip: stagingSkip, after: (r) => r?.cleanup() });
  if (!stagingSkip) { const r = await stage(); contract("StagedFile", r); await r.cleanup(); }
  for (const method of ["assertCurrent", "cleanup", "publish"]) add(`StagedFile.${method}`, (r) => method === "publish" ? r.publish("published-stage", { overwrite: true }) : r[method](), { skip: stagingSkip, before: stage, after: (_, r) => r.cleanup() });
  add("StagedFile.[Symbol.asyncDispose]", (r) => r[Symbol.asyncDispose](), { skip: stagingSkip, before: stage });
  const lockOptions = { payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }), timeoutMs: 1000 };
  const lockPath = path.join(w, "locked");
  for (const suffix of ["", "Sync"]) {
    const sync = suffix === "Sync";
    const acquire = () => a[`acquireFileLock${suffix}`](lockPath, lockOptions);
    add(`acquireFileLock${suffix}`, acquire, { sync, after: (r) => r?.release() });
    add(`withFileLock${suffix}`, () => a[`withFileLock${suffix}`](lockPath, lockOptions, sync ? () => 1 : async () => 1), { sync });
    const r = await acquire();
    const type = `FileLock${suffix}Handle`;
    contract(type, r);
    await r.release();
    for (const method of ["verifyStillHeld", "release"]) add(`${type}.${method}`, (r) => r[method](), { sync, before: acquire, after: (_, r) => r.release() });
    const symbol = sync ? Symbol.dispose : Symbol.asyncDispose;
    add(`${type}.[${sync ? "Symbol.dispose" : "Symbol.asyncDispose"}]`, (r) => r[symbol](), { sync, before: acquire });
  }
  const manager = a.createFileLockManager("fs-safe-benchmark");
  contract("FileLockManager", manager);
  add("createFileLockManager", () => a.createFileLockManager("fs-safe-benchmark"), { sync: true });
  add("FileLockManager.acquire", () => manager.acquire(lockPath, lockOptions), { after: (r) => r?.release() });
  add("FileLockManager.withLock", () => manager.withLock(lockPath, lockOptions, async () => 1));
  add("FileLockManager.heldEntries", () => manager.heldEntries(), { sync: true });
  add("FileLockManager.drain", () => manager.drain());
  add("FileLockManager.reset", () => manager.reset(), { sync: true });
  const held = await manager.acquire(lockPath, lockOptions);
  const heldEntry = manager.heldEntries()[0];
  contract("FileLockHeldEntry", heldEntry);
  await held.release();
  add("FileLockHeldEntry.forceRelease", (entry) => entry.forceRelease(), { before: async () => { await manager.acquire(lockPath, lockOptions); return manager.heldEntries()[0]; }, after: () => manager.drain() });
  const queueDir = path.join(w, "queue");
  const failedDir = path.join(w, "failed");
  await a.ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const queue = a.resolveJsonDurableQueueEntryPaths(queueDir, "fixture");
  const resetQueue = () => { for (const p of Object.values(queue)) fs.rmSync(p, { force: true }); fs.rmSync(path.join(failedDir, "fixture.json"), { force: true }); fs.writeFileSync(queue.jsonPath, '{"ok":true}'); };
  add("resolveJsonDurableQueueEntryPaths", () => a.resolveJsonDurableQueueEntryPaths(queueDir, "fixture"), { sync: true });
  add("ensureJsonDurableQueueDirs", () => a.ensureJsonDurableQueueDirs({ queueDir, failedDir }));
  add("writeJsonDurableQueueEntry", () => a.writeJsonDurableQueueEntry({ filePath: queue.jsonPath, entry: { ok: true }, tempPrefix: "bench" }));
  add("jsonDurableQueueEntryExists", () => a.jsonDurableQueueEntryExists(queue.jsonPath), { before: resetQueue });
  add("readJsonDurableQueueEntry", () => a.readJsonDurableQueueEntry(queue.jsonPath), { before: resetQueue, verify: (r) => assert(r.ok) });
  add("loadJsonDurableQueueEntry", () => a.loadJsonDurableQueueEntry({ paths: queue, tempPrefix: "bench" }), { before: resetQueue, verify: (r) => assert(r.ok) });
  add("loadPendingJsonDurableQueueEntries", () => a.loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "bench" }), { before: resetQueue, verify: (r) => assert.equal(r.length, 1) });
  const claim = async () => { resetQueue(); await a.loadJsonDurableQueueEntry({ paths: queue, tempPrefix: "bench" }); };
  add("ackJsonDurableQueueEntry", () => a.ackJsonDurableQueueEntry(queue), { before: claim });
  add("moveJsonDurableQueueEntryToFailed", () => a.moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "fixture" }), { before: claim });
  add("unlinkBestEffort", () => a.unlinkBestEffort(queue.jsonPath), { before: resetQueue });
}
