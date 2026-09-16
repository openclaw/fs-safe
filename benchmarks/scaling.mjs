import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  registerRootWriteMutationAdmission,
  registerSharedMutationAdmission,
} from "./shared-mutation-admission.mjs";

async function settledValues(pending) {
  const results = await Promise.allSettled(pending);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map(result => result.value);
}

export async function registerScaling({ api: a, workspace: w, register: add, onCleanup }) {
  const root = await a.root(w), store = a.fileStore({ rootDir: w });
  for (const size of [128, 64 * 1024, 1024 * 1024]) {
    const payload = Buffer.alloc(size, 0x5a), name = `concurrent-read-${size}`;
    fs.writeFileSync(path.join(w, name), payload, { mode: 0o600 });
    for (const concurrency of [1, 8, 32]) {
      for (const [type, reader] of [["Root", root], ["FileStore", store]]) {
        add(`${type}.readBytes/${size}/concurrent=${concurrency}`, () =>
          settledValues(Array.from({ length: concurrency }, () => reader.readBytes(name))), {
          divisor: 10,
          verify: buffers => {
            assert.equal(buffers.length, concurrency);
            for (const buffer of buffers) assert.ok(buffer.equals(payload));
          },
        });
      }
    }
  }
  registerRootWriteMutationAdmission({ root, workspace: w, register: add });
  registerSharedMutationAdmission({ root, workspace: w, register: add });

  const renameDenied = () => { throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EPERM" }); };
  const asyncFs = { promises: { ...fs.promises, rename: async () => renameDenied() } };
  const syncFs = { ...fs, renameSync: renameDenied };
  const dest = path.join(w, "fallback-output");
  for (const size of [128, 1024 * 1024, 16 * 1024 * 1024]) {
    const original = Buffer.alloc(size, 0xa5), content = Buffer.alloc(size, 0x5a);
    for (const restore of ["none", "restore-original"]) {
      for (const sync of [false, true]) {
        const name = sync ? "replaceFileAtomicSync" : "replaceFileAtomic";
        add(`${name}/copy-fallback/${restore}/${size}`, () => a[name]({
          filePath: dest, content, fileSystem: sync ? syncFs : asyncFs,
          copyFallbackOnPermissionError: true, copyFallbackRestore: restore,
          maxRestoreBytes: restore === "restore-original" ? size : undefined,
          syncTempFile: false, syncParentDir: false,
        }), {
          sync, divisor: 100,
          before: () => fs.writeFileSync(dest, original, { mode: 0o600 }),
          verify: result => {
            assert.equal(result.method, "copy-fallback");
            assert.ok(fs.readFileSync(dest).equals(content));
          },
        });
      }
    }
  }

  for (const count of [0, 32, 128]) {
    const key = `scaling:${w}:${count}`, manager = a.createFileLockManager(key);
    onCleanup(() => manager.drain());
    add(`createFileLockManager/held=${count}/batch=100`, () => {
      let result;
      for (let index = 0; index < 100; index++) result = a.createFileLockManager(key);
      return result;
    }, {
      sync: true, divisor: 100,
      before: async () => {
        for (let index = 0; index < count; index++) {
          await manager.acquire(path.join(w, `held-${count}-${index}`), {
            payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
          });
        }
      },
      verify: result => assert.equal(result.heldEntries().length, count),
      after: async () => {
        await manager.drain();
        assert.equal(manager.heldEntries().length, 0);
      },
    });
  }

  for (const count of [100, 1000]) {
    const rootDir = path.join(w, `prune-current-${count}`);
    fs.mkdirSync(rootDir);
    for (let index = 0; index < count; index++) fs.writeFileSync(path.join(rootDir, `entry-${index}`), "x");
    const files = a.fileStore({ rootDir });
    add(`FileStore.pruneExpired/current=${count}`, () => files.pruneExpired({ ttlMs: Infinity }), {
      divisor: 100, verify: () => assert.equal(fs.readdirSync(rootDir).length, count),
    });
  }

  const inventory = rootDir => {
    const found = [];
    const visit = (directory, prefix = "") => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        found.push(relative + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      }
    };
    visit(rootDir);
    return found.sort();
  };
  const addPruneFixture = (name, { setup, expected, options, divisor, workloadDetails }) => {
    const rootDir = path.join(w, `prune-empty-dir-policy-${name.replaceAll("/", "-")}`);
    fs.mkdirSync(rootDir);
    const files = a.fileStore({ rootDir });
    add(`nonrecursive-removal-kind/FileStore.pruneExpired/${name}`, () => files.pruneExpired(options), {
      before: () => {
        fs.rmSync(rootDir, { recursive: true, force: true });
        fs.mkdirSync(rootDir);
        setup(rootDir);
      },
      after: () => assert.deepEqual(inventory(rootDir), expected),
      divisor,
      workloadDetails,
    });
  };
  const createFiles = (rootDir, count, expired) => {
    for (let index = 0; index < count; index++) {
      const file = path.join(rootDir, `file-${index}`);
      fs.writeFileSync(file, "x");
      if (expired) fs.utimesSync(file, new Date(0), new Date(0));
    }
  };
  const createChains = (rootDir, count, depth) => {
    for (let index = 0; index < count; index++) {
      const parts = [`chain-${index}`, ...Array.from({ length: depth - 1 }, (_, part) => `d${part + 1}`)];
      fs.mkdirSync(path.join(rootDir, ...parts), { recursive: true });
    }
  };
  const chainInventory = (count, depth) => {
    const entries = [];
    for (let index = 0; index < count; index++) {
      const parts = [`chain-${index}`, ...Array.from({ length: depth - 1 }, (_, part) => `d${part + 1}`)];
      for (let length = 1; length <= parts.length; length++) entries.push(`${parts.slice(0, length).join("/")}/`);
    }
    return entries.sort();
  };
  addPruneFixture("ordinary-current-64", {
    setup: rootDir => createFiles(rootDir, 64, false),
    expected: Array.from({ length: 64 }, (_, index) => `file-${index}`).sort(),
    options: { ttlMs: Infinity }, divisor: 1,
    workloadDetails: { files: 64, directories: 0, pruneEmptyDirs: false,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  addPruneFixture("ordinary-expired-64", {
    setup: rootDir => createFiles(rootDir, 64, true), expected: [],
    options: { ttlMs: 1 }, divisor: 8,
    workloadDetails: { files: 64, directories: 0, pruneEmptyDirs: false,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  addPruneFixture("disabled-nested-16x4", {
    setup: rootDir => createChains(rootDir, 16, 4), expected: chainInventory(16, 4),
    options: { ttlMs: Infinity, recursive: true, pruneEmptyDirs: false }, divisor: 4,
    workloadDetails: { files: 0, directories: 64, pruneEmptyDirs: false,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  addPruneFixture("flat-empty-1", {
    setup: rootDir => fs.mkdirSync(path.join(rootDir, "empty-0")), expected: [],
    options: { ttlMs: Infinity, recursive: true, pruneEmptyDirs: true }, divisor: 1,
    workloadDetails: { files: 0, directories: 1, removalAttempts: 1,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  addPruneFixture("flat-empty-64", {
    setup: rootDir => { for (let index = 0; index < 64; index++) fs.mkdirSync(path.join(rootDir, `empty-${index}`)); },
    expected: [], options: { ttlMs: Infinity, recursive: true, pruneEmptyDirs: true }, divisor: 8,
    workloadDetails: { files: 0, directories: 64, removalAttempts: 64,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  addPruneFixture("nested-empty-16x4", {
    setup: rootDir => createChains(rootDir, 16, 4), expected: [],
    options: { ttlMs: Infinity, recursive: true, pruneEmptyDirs: true }, divisor: 8,
    workloadDetails: { files: 0, directories: 64, removalAttempts: 64,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  addPruneFixture("max-depth-1", {
    setup: rootDir => {
      for (let index = 0; index < 16; index++) {
        fs.mkdirSync(path.join(rootDir, `empty-${index}`));
        fs.mkdirSync(path.join(rootDir, `parent-${index}`, "deep"), { recursive: true });
      }
    },
    expected: Array.from({ length: 16 }, (_, index) => [`parent-${index}/`, `parent-${index}/deep/`]).flat().sort(),
    options: { ttlMs: Infinity, maxDepth: 1, pruneEmptyDirs: true }, divisor: 4,
    workloadDetails: { files: 0, directories: 48, removalAttempts: 16,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  const removeFile = path.join(w, "nonrecursive-removal-kind-file");
  add("nonrecursive-removal-kind/Root.remove/file", () => root.remove(path.basename(removeFile)), {
    before: () => fs.writeFileSync(removeFile, "x"),
    after: () => assert.equal(fs.existsSync(removeFile), false),
    divisor: 8,
    workloadDetails: { kind: "file", marker: false,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
  const removeDirectory = path.join(w, "nonrecursive-removal-kind-directory");
  add("nonrecursive-removal-kind/Root.remove/empty-directory", () => root.remove(path.basename(removeDirectory)), {
    before: () => {
      fs.rmSync(removeDirectory, { recursive: true, force: true });
      fs.mkdirSync(removeDirectory);
    },
    after: () => assert.equal(fs.existsSync(removeDirectory), false),
    divisor: 8,
    workloadDetails: { kind: "directory", marker: false,
      expectedCandidateMinusBaselineLstatCalls: 0, callCountBasis: "source-derived; not instrumented" },
  });
}
