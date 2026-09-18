import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  registerTempWorkspaceCoverage,
  registerTempWorkspaceFallbackCleanup,
} from "./temp-workspace-fixtures.mjs";
import { registerSecureTempRootCoverage } from "./secure-temp-root-fixtures.mjs";
import { registerSidecarPathSnapshot } from "./sidecar-path-snapshot.mjs";
import { registerAtomicTempSettlementCoverage } from "./atomic-temp-settlement.mjs";
import {
  PROBE_TREE_SUCCESS_WORKLOAD,
  probeTreeSuccessFixtureReceipt,
  registerCopyTreeSuccess,
} from "./copy-tree-success.mjs";

export async function registerCloneMetadata({ api: a, workspace: w, cloneBackend, register: add }) {
  const verify = (entries) => {
    assert.equal(entries.length, 1);
    if (process.platform !== "darwin") assert.deepEqual(entries, [undefined]);
    if (cloneBackend === "apfs") assert.equal(entries[0]?.type, 1);
  };
  let skip;
  try {
    verify(await a.readCloneFileMetadata([path.join(w, "input.json")]));
  } catch (error) {
    if (error?.code !== "helper-unavailable") throw error;
    skip = "Native metadata reader unavailable.";
  }
  add("readCloneFileMetadata", () => a.readCloneFileMetadata([path.join(w, "input.json")]), {
    skip,
    verify,
  });
}

export async function registerLifecycle({ api: a, workspace: w, native, binding, register: add, contract, onCleanup, args }) {
  const cloneBackend = a.probeTreeClone(w);
  add("probeTreeClone", () => a.probeTreeClone(w), {
    sync: true,
    workloadSemantics: "equivalent-output",
    workloadDetails: PROBE_TREE_SUCCESS_WORKLOAD,
    fixturePlacement: probeTreeSuccessFixtureReceipt(cloneBackend ?? null, args.mode, native),
    after: (backend) => assert.equal(backend, cloneBackend),
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
  await registerCopyTreeSuccess({
    api: a, workspace: w, binding, register: add, nativeMode: args.mode,
  });
  await registerCloneMetadata({ api: a, workspace: w, cloneBackend, register: add });
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
  registerAtomicTempSettlementCoverage({
    api: a,
    workspace: w,
    register: add,
    onCleanup,
  });
  add("writeTextAtomic", () => a.writeTextAtomic(output, "synthetic benchmark"));
  const newRootBytes = Buffer.from("new-root\n");
  const newNestedBytes = Buffer.from("new-nested\n");
  for (const targetState of ["absent", "existing"]) {
    for (const parentShape of ["shared", "distinct"]) {
      const rowRoot = path.join(w, `replace-directory-${targetState}-${parentShape}`);
      const targetParent = path.join(rowRoot, "target-parent");
      const stagedParent = parentShape === "shared"
        ? targetParent
        : path.join(rowRoot, "staged-parent");
      const stagedDir = path.join(stagedParent, "staged");
      const targetDir = path.join(targetParent, "target");
      fs.mkdirSync(targetParent, { recursive: true });
      fs.mkdirSync(stagedParent, { recursive: true });
      const parentIdentities = [...new Set([targetParent, stagedParent])]
        .map(parent => [parent, fs.lstatSync(parent, { bigint: true })]);
      add(`replaceDirectoryAtomic/${targetState}/${parentShape}`, () => a.replaceDirectoryAtomic({
        stagedDir,
        targetDir,
        backupPrefix: ".bench-backup-",
      }), {
        skip: !native ? "Directory replacement requires the native binding." : undefined,
        workloadDetails: { targetState, parentShape, files: 2 },
        fixturePlacement: "The staged and existing trees are recreated before timing; validation and reset run after timing.",
        before: () => {
          fs.mkdirSync(path.join(stagedDir, "nested"), { recursive: true });
          fs.writeFileSync(path.join(stagedDir, "new.txt"), newRootBytes);
          fs.writeFileSync(path.join(stagedDir, "nested", "new.txt"), newNestedBytes);
          if (targetState === "existing") {
            fs.mkdirSync(path.join(targetDir, "nested"), { recursive: true });
            fs.writeFileSync(path.join(targetDir, "old.txt"), "old-root\n");
            fs.writeFileSync(path.join(targetDir, "nested", "old.txt"), "old-nested\n");
          }
          return fs.lstatSync(stagedDir, { bigint: true });
        },
        after: (_, stagedIdentity) => {
          const published = fs.lstatSync(targetDir, { bigint: true });
          assert.equal(published.dev, stagedIdentity.dev);
          assert.equal(published.ino, stagedIdentity.ino);
          assert.equal(fs.existsSync(stagedDir), false);
          assert.deepEqual(fs.readdirSync(targetDir).sort(), ["nested", "new.txt"]);
          assert.deepEqual(fs.readdirSync(path.join(targetDir, "nested")), ["new.txt"]);
          assert(fs.readFileSync(path.join(targetDir, "new.txt")).equals(newRootBytes));
          assert(fs.readFileSync(path.join(targetDir, "nested", "new.txt")).equals(newNestedBytes));
          assert.equal(fs.existsSync(path.join(targetDir, "old.txt")), false);
          assert.equal(fs.existsSync(path.join(targetDir, "nested", "old.txt")), false);
          assert.deepEqual(
            fs.readdirSync(targetParent).filter(name => name.startsWith(".bench-backup-")),
            [],
          );
          for (const [parent, expected] of parentIdentities) {
            const current = fs.lstatSync(parent, { bigint: true });
            assert.equal(current.dev, expected.dev);
            assert.equal(current.ino, expected.ino);
          }
          fs.rmSync(targetDir, { recursive: true, force: true });
        },
      });
    }
  }
  const invalidDirectoryStage = path.join(w, "invalid-staged-dir");
  const invalidDirectoryTarget = path.join(w, "invalid-target-dir");
  add("replaceDirectoryAtomic/validation/invalid-backup-prefix", () => a.replaceDirectoryAtomic({
    stagedDir: invalidDirectoryStage,
    targetDir: invalidDirectoryTarget,
    backupPrefix: "invalid/prefix",
  }), {
    expectError: true,
    verify: error => assert.equal(error?.code, "invalid-path"),
    after: error => {
      assert.equal(error?.code, "invalid-path");
      assert.equal(fs.existsSync(invalidDirectoryStage), false);
      assert.equal(fs.existsSync(invalidDirectoryTarget), false);
    },
  });
  add("movePathWithCopyFallback", () => a.movePathWithCopyFallback({ from: path.join(w, "move-source"), to: output }), { before: () => fs.writeFileSync(path.join(w, "move-source"), data) });
  for (const shape of ["empty", "wide", "deep"]) {
    const source = path.join(w, `move-copy-${shape}-source`);
    const target = path.join(w, `move-copy-${shape}-target`);
    const directories = Array.from({ length: shape === "empty" ? 0 : 32 }, (_, index) => shape === "wide"
      ? `d${index}` : Array(index + 1).fill("d").join(path.sep));
    const payload = Buffer.alloc(128, 0x5a);
    add(`movePathWithCopyFallback/forced-copy/${shape}/directories=${directories.length + 1}`, () => a.movePathWithCopyFallback({
      from: source, to: target, sourceHardlinks: "reject",
    }), {
      divisor: 10,
      workloadDetails: { shape, directories: directories.length + 1, files: directories.length, bytesPerFile: 128, sourceHardlinks: "reject" },
      before: () => {
        fs.mkdirSync(source);
        for (const directory of directories) {
          fs.mkdirSync(path.join(source, directory), { recursive: true });
          fs.writeFileSync(path.join(source, directory, "payload"), payload);
        }
      },
      verify: () => {
        assert.equal(fs.existsSync(source), false);
        assert.deepEqual(fs.readdirSync(target).sort(), shape === "deep" ? ["d"] : directories.toSorted());
        for (const [index, directory] of directories.entries()) {
          const expected = shape === "deep" && index < directories.length - 1 ? ["d", "payload"] : ["payload"];
          assert.deepEqual(fs.readdirSync(path.join(target, directory)).sort(), expected);
          assert(fs.readFileSync(path.join(target, directory, "payload")).equals(payload));
        }
      },
      after: () => {
        fs.rmSync(source, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
      },
    });
  }
  for (const name of ["writeSecretFileAtomic", "createSecretFileAtomic"]) add(name, () => a[name]({ rootDir: secretRoot, filePath: path.join(secretRoot, "secret-out"), content: data }), {
    before: () => name === "createSecretFileAtomic"
      ? fs.rmSync(path.join(secretRoot, "secret-out"), { force: true })
      : fs.writeFileSync(path.join(secretRoot, "secret-out"), data, { mode: 0o600 }),
  });
  add("writeExternalFileWithinRoot", () => a.writeExternalFileWithinRoot({ rootDir: w, path: "external-out", write: (p) => fsp.writeFile(p, data) }));
  add("writeExternalFileWithinRoot/isolated-sibling", () => a.writeExternalFileWithinRoot({
    rootDir: w, path: "external-isolated-out", staging: "sibling",
    producerIsolation: "private-directory", write: (p) => fsp.writeFile(p, data),
  }));
  add("writeSiblingTempFile", () => a.writeSiblingTempFile({ dir: w, writeTemp: (p) => fsp.writeFile(p, data), resolveFinalPath: () => output }));
  add("writeSiblingTempFile/isolated", () => a.writeSiblingTempFile({
    dir: w, producerIsolation: "private-directory", writeTemp: (p) => fsp.writeFile(p, data),
    resolveFinalPath: () => output,
  }));
  add("writeViaSiblingTempPath", () => a.writeViaSiblingTempPath({ rootDir: w, targetPath: output, writeTemp: (p) => fsp.writeFile(p, data) }));
  const tempOptions = { rootDir: w, prefix: "fixture" };
  registerSecureTempRootCoverage({ api: a, workspace: w, register: add });
  for (const suffix of ["", "Sync"]) {
    const name = `tempWorkspace${suffix}`;
    const type = `TempWorkspace${suffix}`;
    const sync = suffix === "Sync";
    registerTempWorkspaceCoverage({
      api: a,
      workspace: w,
      register: add,
      tempOptions,
      suffix,
    });
    add(`withTempWorkspace${suffix}`, () => a[`withTempWorkspace${suffix}`](tempOptions, sync ? () => 1 : async () => 1), { sync, before: () => {} });
    const tmp = await a[name](tempOptions);
    contract(type, tmp);
    onCleanup(() => tmp.cleanup());
    await tmp.write("input.json", data);
    for (const method of ["path", "read", "write", "writeText", "writeJson", ...(sync ? [] : ["copyIn"])]) {
      add(`${type}.${method}`, () => tmp[method](method === "read" || method === "path" ? "input.json" : "output.json", method === "writeJson" ? { ok: true } : method === "copyIn" ? input : data), { sync: sync || method === "path", before: method.startsWith("write") && sync ? () => {} : undefined });
    }
    add(`${type}.cleanup`, (r) => r.cleanup(), {
      sync,
      before: () => a[name](tempOptions),
      after: (result, workspace) => {
        assert.equal(result, "removed", `${type}.cleanup did not remove its workspace`);
        assert.equal(fs.existsSync(workspace.dir), false, `${type}.cleanup left its public path`);
      },
    });
    registerTempWorkspaceFallbackCleanup({
      api: a,
      nativeMode: args.mode,
      register: add,
      suffix,
      tempOptions,
    });
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
  const noReplaceSuccessParent = path.join(w, "staged-no-replace-success");
  const noReplaceCollisionParent = path.join(w, "staged-no-replace-collision");
  fs.mkdirSync(noReplaceSuccessParent);
  fs.mkdirSync(noReplaceCollisionParent);
  const noReplaceBytes = Buffer.from("staged-no-replace\n");
  const finishStagedPublish = async (staged, target, verifyPublication, verifyCleanup) => {
    const failures = [];
    try { verifyPublication(); } catch (error) { failures.push(error); }
    try { verifyCleanup(await staged.cleanup()); } catch (error) { failures.push(error); }
    try { fs.rmSync(target, { force: true }); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "staged publish benchmark validation and cleanup failed");
    }
  };
  const noReplaceSuccessTarget = path.join(noReplaceSuccessParent, "published");
  add("StagedFile.publish/overwrite=false/success", staged => staged.publish(
    "published",
    { overwrite: false },
  ), {
    skip: stagingSkip,
    fixturePlacement: "Stage creation and final-name reset occur outside the timed publish call.",
    before: async () => {
      fs.rmSync(noReplaceSuccessTarget, { force: true });
      return a.stageFileInDirectory({ directory: noReplaceSuccessParent, content: noReplaceBytes });
    },
    after: (published, staged) => finishStagedPublish(
      staged,
      noReplaceSuccessTarget,
      () => {
        assert.equal(published.status, "published");
        assert.equal(published.basename, "published");
        assert.equal(published.overwrite, false);
        assert.equal(published.staged, staged.receipt);
        const current = fs.lstatSync(noReplaceSuccessTarget, { bigint: true });
        assert.equal(current.dev, staged.receipt.identity.dev);
        assert.equal(current.ino, staged.receipt.identity.ino);
        assert(fs.readFileSync(noReplaceSuccessTarget).equals(noReplaceBytes));
        assert.equal(
          fs.existsSync(path.join(noReplaceSuccessParent, staged.receipt.temporaryBasename)),
          false,
        );
      },
      cleanup => {
        assert.equal(cleanup.resources, "closed");
        assert.equal(cleanup.status, "not-needed");
        assert.equal(cleanup.publication, published);
      },
    ),
  });
  const competitorBytes = Buffer.from("competitor\n");
  const noReplaceCollisionTarget = path.join(noReplaceCollisionParent, "published");
  add("StagedFile.publish/overwrite=false/collision", fixture => fixture.staged.publish(
    "published",
    { overwrite: false },
  ), {
    skip: stagingSkip,
    expectError: true,
    fixturePlacement: "Stage and competitor creation occur outside the timed collision call; cleanup and validation follow it.",
    before: async () => {
      fs.writeFileSync(noReplaceCollisionTarget, competitorBytes);
      const competitor = fs.lstatSync(noReplaceCollisionTarget, { bigint: true });
      const staged = await a.stageFileInDirectory({
        directory: noReplaceCollisionParent,
        content: noReplaceBytes,
      });
      return { competitor, staged };
    },
    after: (error, { competitor, staged }) => {
      const stagedPath = path.join(noReplaceCollisionParent, staged.receipt.temporaryBasename);
      return finishStagedPublish(
        staged,
        noReplaceCollisionTarget,
        () => {
          assert.equal(error?.code, "already-exists");
          assert.equal(error?.details?.phase, "publish");
          assert.equal(error?.details?.publication?.status, "indeterminate");
          assert.equal(error?.cause?.code, "EEXIST");
          const currentCompetitor = fs.lstatSync(noReplaceCollisionTarget, { bigint: true });
          assert.equal(currentCompetitor.dev, competitor.dev);
          assert.equal(currentCompetitor.ino, competitor.ino);
          assert(fs.readFileSync(noReplaceCollisionTarget).equals(competitorBytes));
          const currentStage = fs.lstatSync(stagedPath, { bigint: true });
          assert.equal(currentStage.dev, staged.receipt.identity.dev);
          assert.equal(currentStage.ino, staged.receipt.identity.ino);
        },
        cleanup => {
          assert.equal(cleanup.resources, "closed");
          assert.equal(cleanup.status, "preserved");
          assert.equal(cleanup.publication.status, "indeterminate");
          assert(fs.readFileSync(stagedPath).equals(noReplaceBytes));
          // The runner owns this fixture after the lifecycle closes its resources.
          fs.unlinkSync(stagedPath);
        },
      );
    },
  });
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
  registerSidecarPathSnapshot({ api: a, workspace: w, register: add, onCleanup });
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
