import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function registerLifecycle({ api: a, workspace: w, native, binding, register: add, contract, onCleanup, args }) {
  const cloneBackend = a.probeTreeClone(w);
  add("probeTreeClone", () => a.probeTreeClone(w), {
    sync: true,
    verify: (backend) => assert.equal(backend, cloneBackend),
  });
  const cloneSource = path.join(w, "clone-source");
  const cloneTarget = path.join(w, "clone-target");
  const clonePreparation = path.join(w, "clone-preparation");
  const cloneSkip = !cloneBackend
    ? "Native directory cloning requires APFS, Btrfs, ReFS, XFS, or ZFS."
    : undefined;
  if (cloneBackend) {
    await a.createCloneSource(cloneSource);
  } else {
    fs.mkdirSync(cloneSource);
  }
  const shape = args["copy-shape"];
  const cloneDirectories = ["empty", ...(shape === "mixed" ? ["nested"] : [])];
  const cloneContents = new Map(shape === "mixed" ? [["payload", Buffer.alloc(1024 * 1024, 0x5a)]] : []);
  for (let i = 0; shape !== "empty" && i < args["copy-files"]; i++) {
    if (shape === "nested") cloneDirectories.push(`directory-${i}`);
    const name = shape === "nested" ? `directory-${i}/file` : shape === "mixed" && i % 2 ? `nested/file-${i}` : `file-${i}`;
    cloneContents.set(name, Buffer.alloc(args["copy-file-bytes"], i % 251 + 1));
  }
  for (const name of cloneDirectories) fs.mkdirSync(path.join(cloneSource, name));
  for (const [name, bytes] of cloneContents) fs.writeFileSync(path.join(cloneSource, name), bytes);
  const cloneNames = fs.readdirSync(cloneSource).sort();
  const directoryNames = new Map(cloneDirectories.map(name => [name, fs.readdirSync(path.join(cloneSource, name)).sort()]));
  add("createCloneSource", () => a.createCloneSource(clonePreparation), {
    skip: cloneSkip,
    verify: () => assert(fs.statSync(clonePreparation).isDirectory()),
    after: () => fs.rmSync(clonePreparation, { recursive: true, force: true }),
  });
  for (const concurrency of args["copy-concurrency"] ?? [undefined]) {
    for (const clone of ["auto", "never", "always"]) {
      add(`copyTree/${clone}/${shape}${concurrency === undefined ? "" : `/workers=${concurrency}`}`, () => a.copyTree(cloneSource, cloneTarget, { clone, concurrency }), {
        divisor: 10,
        skip: clone === "always" ? cloneSkip : undefined,
        verify: () => {
          assert.deepEqual(fs.readdirSync(cloneTarget).sort(), cloneNames);
          for (const [name, entries] of directoryNames) assert.deepEqual(fs.readdirSync(path.join(cloneTarget, name)).sort(), entries);
          for (const [name, bytes] of cloneContents) assert(fs.readFileSync(path.join(cloneTarget, name)).equals(bytes), name);
        },
        after: () => fs.rmSync(cloneTarget, { recursive: true, force: true }),
      });
    }
  }
  add("readCloneFileMetadata", () => a.readCloneFileMetadata([path.join(w, "input.json")]), {
    skip: !native ? "Native metadata reader unavailable." : undefined,
    verify: (entries) => {
      assert.equal(entries.length, 1);
      if (cloneBackend === "apfs") assert.equal(entries[0]?.type, 1);
    },
  });
  if (binding) {
    const directory = path.join(w, "native-directory");
    fs.mkdirSync(directory);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
    const rootFd = fs.openSync(w, flags);
    const rootIdentity = fs.fstatSync(rootFd);
    const directoryIdentity = fs.statSync(directory);
    onCleanup(() => fs.closeSync(rootFd));
    add("native.fstatIdentity/directory", () => binding.fstatIdentity(rootFd), {
      sync: true,
      verify: (identity) => {
        assert.equal(identity.isDirectory, true);
        assert.equal(identity.dev, rootIdentity.dev);
        assert.equal(identity.ino, rootIdentity.ino);
      },
    });
    add("native.openBeneath/directory", () => binding.openBeneath(rootFd, "native-directory", flags), {
      sync: true,
      verify: (opened) => {
        const identity = fs.fstatSync(opened.fd);
        assert.equal(identity.isDirectory(), true);
        assert.equal(identity.dev, directoryIdentity.dev);
        assert.equal(identity.ino, directoryIdentity.ino);
      },
      after: (opened) => { if (opened) fs.closeSync(opened.fd); },
    });
  } else {
    add("native.fstatIdentity/directory", () => {}, { skip: "native binding unavailable" });
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
  const directRequestedModePlatform = process.platform === "linux" || process.platform === "darwin";
  add("resolveSecureTempRoot", () => a.resolveSecureTempRoot({ preferredDir: secretRoot, fallbackPrefix: "fs-safe-benchmark" }), { sync: true });
  for (const suffix of ["", "Sync"]) {
    const name = `tempWorkspace${suffix}`;
    const type = `TempWorkspace${suffix}`;
    const sync = suffix === "Sync";
    add(name, () => a[name](tempOptions), { sync, after: (r) => r?.cleanup() });
    // The historical row keeps its stable name. On Linux/macOS sync it now
    // measures requested-mode creation whose ordinary-umask path avoids correction.
    const ordinaryProbe = path.join(w, ".fs-safe-temp-mode-ordinary-probe");
    add(`${name}/mode-correction`, () => a[name]({ ...tempOptions, dirMode: 0o750 }), {
      sync,
      skip: process.platform === "win32" ? "Windows does not initialize POSIX directory modes." : undefined,
      before: sync && directRequestedModePlatform
        ? () => {
            fs.rmSync(ordinaryProbe, { recursive: true, force: true });
            fs.mkdirSync(ordinaryProbe, { mode: 0o750 });
            try {
              const initial = fs.lstatSync(ordinaryProbe);
              assert.equal(initial.isDirectory(), true);
              assert.equal(initial.isSymbolicLink(), false);
              assert.equal(initial.mode & 0o7777, 0o750,
                "ordinary requested-mode preflight did not produce initial mode 0750");
              assert.equal(initial.uid, process.geteuid());
            } finally {
              fs.rmSync(ordinaryProbe, { recursive: true, force: true });
            }
          }
        : undefined,
      after: (r) => r?.cleanup(),
    });
    if (sync) {
      let previousUmask;
      const correctionProbe = path.join(w, ".fs-safe-temp-mode-correction-probe");
      const resetForcedCorrectionSetup = () => {
        const failures = [];
        try {
          fs.rmSync(correctionProbe, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        const restoreUmask = previousUmask;
        previousUmask = undefined;
        if (restoreUmask !== undefined) {
          try {
            process.umask(restoreUmask);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "forced mode-correction benchmark reset failed");
        }
      };
      add(`${name}/forced-mode-correction`, () => a[name]({ ...tempOptions, dirMode: 0o750 }), {
        sync: true,
        skip: directRequestedModePlatform
          ? undefined
          : "The requested-mode direct creation path requires Linux or macOS.",
        before: () => {
          try {
            assert.equal(previousUmask, undefined, "forced mode-correction benchmark setup leaked");
            previousUmask = process.umask(0o077);
            fs.mkdirSync(correctionProbe, { mode: 0o750 });
            const initial = fs.lstatSync(correctionProbe);
            assert.equal(initial.isDirectory(), true);
            assert.equal(initial.isSymbolicLink(), false);
            assert.equal(initial.mode & 0o7777, 0o700,
              "forced mode-correction preflight did not produce initial mode 0700");
            assert.equal(initial.uid, process.geteuid());
            fs.rmdirSync(correctionProbe);
          } catch (error) {
            try {
              resetForcedCorrectionSetup();
            } catch (resetError) {
              throw new AggregateError(
                [error, resetError],
                "forced mode-correction benchmark preflight and reset failed",
              );
            }
            throw error;
          }
        },
        after: (workspace) => {
          const failures = [];
          let stat;
          let cleanupResult;
          if (workspace) {
            try {
              stat = fs.lstatSync(workspace.dir);
            } catch (error) {
              failures.push(error);
            }
            try {
              cleanupResult = workspace.cleanup();
            } catch (error) {
              failures.push(error);
            }
          }
          try {
            resetForcedCorrectionSetup();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(failures, "forced mode-correction benchmark cleanup failed");
          }
          if (!workspace) return;
          assert.equal(stat.isDirectory(), true);
          assert.equal(stat.isSymbolicLink(), false);
          assert.equal(stat.mode & 0o7777, 0o750);
          assert.equal(stat.uid, process.geteuid());
          assert.equal(cleanupResult, "removed");
          assert.equal(fs.existsSync(workspace.dir), false);
        },
      });
    }
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
  for (const batch of [false, true]) {
    const method = batch ? "loadPendingJsonDurableQueueEntries" : "loadJsonDurableQueueEntry";
    const migrated = { ok: true, migrated: true };
    add(`${method}/migration`, () => a[method]({
      ...(batch ? { queueDir } : { paths: queue }),
      tempPrefix: "bench",
      read: async (entry) => ({ entry: { ...entry, migrated: true }, migrated: true }),
    }), {
      before: resetQueue,
      verify: (result) => {
        assert.deepEqual(result, batch ? [migrated] : migrated);
        assert.deepEqual(JSON.parse(fs.readFileSync(queue.processingPath, "utf8")), migrated);
        assert.equal(fs.existsSync(queue.jsonPath), false);
      },
    });
  }
  const claim = async () => { resetQueue(); await a.loadJsonDurableQueueEntry({ paths: queue, tempPrefix: "bench" }); };
  add("ackJsonDurableQueueEntry", () => a.ackJsonDurableQueueEntry(queue), { before: claim });
  add("moveJsonDurableQueueEntryToFailed", () => a.moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "fixture" }), { before: claim });
  add("unlinkBestEffort", () => a.unlinkBestEffort(queue.jsonPath), { before: resetQueue });
}
