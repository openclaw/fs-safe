// Run after pnpm build: node scripts/atomic-rename-compat-proof.mjs EXISTING_PARENT
// Uses only a fresh child directory. JSON output deliberately omits local paths.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic, replaceFileAtomicSync } from "../dist/atomic.js";
import { writeSiblingTempFile } from "../dist/sibling-temp.js";

assert.equal(process.argv.length, 3, "Pass an existing parent on the filesystem to test");
const parent = await fsp.realpath(process.argv[2]);
const report = { node: process.version, platform: process.platform, cases: [] };
const buildHash = createHash("sha256");
const dist = new URL("../dist/", import.meta.url);
for (const name of (await fsp.readdir(dist)).filter((name) => name.endsWith(".js")).sort()) {
  buildHash.update(name).update("\0").update(await fsp.readFile(new URL(name, dist)));
}
report.buildJsSha256 = buildHash.digest("hex");
const sandbox = await fsp.mkdtemp(path.join(parent, "fs-safe-rename-proof-"));
assert.equal(path.dirname(sandbox), parent);
let caseNumber = 0;
const content = '{"value":"portable"}\n';
const identity = (stat) => `${stat.dev}:${stat.ino}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function freshCase() {
  const directory = path.join(sandbox, String(++caseNumber));
  await fsp.mkdir(directory, { mode: 0o700 });
  return directory;
}

async function invoke(sync, options) {
  try {
    const result = sync ? replaceFileAtomicSync(options) : await replaceFileAtomic(options);
    assert.equal(result.method, "rename");
    return "rename";
  } catch (error) {
    if (error.code === "path-mismatch") return error.code;
    throw error;
  }
}

async function realRename(sync, renameIdentity, length, tempPrefix) {
  const directory = await freshCase();
  const name = `${"x".repeat(length - 5)}.json`;
  const filePath = path.join(directory, name);
  const sentinel = path.join(directory, "save.tmp");
  await fsp.writeFile(sentinel, "unrelated", { flag: "wx" });
  let stagedIdentity;
  let publishedIdentity;
  const beforeRename = ({ tempPath }) => {
    assert.notEqual(tempPath, sentinel);
    stagedIdentity = identity(fs.statSync(tempPath, { bigint: true }));
  };
  const observePublication = (destination) => {
    publishedIdentity = identity(fs.statSync(destination, { bigint: true }));
  };
  const fileSystem = sync ? {
    ...fs,
    renameSync(source, destination) {
      fs.renameSync(source, destination);
      observePublication(destination);
    },
  } : { promises: {
    ...fsp,
    async rename(source, destination) {
      await fsp.rename(source, destination);
      observePublication(destination);
    },
  } };
  const outcome = await invoke(sync, {
    filePath, content, renameIdentity, tempPrefix, beforeRename, fileSystem,
    syncTempFile: true, syncParentDir: true,
  });
  assert.ok(stagedIdentity && publishedIdentity);
  const drifted = stagedIdentity !== publishedIdentity;
  assert.equal(outcome, renameIdentity !== "verify-content-with-lock" && drifted
    ? "path-mismatch" : "rename");
  const bytes = await fsp.readFile(filePath);
  assert.equal(bytes.toString(), content);
  assert.equal(await fsp.readFile(sentinel, "utf8"), "unrelated");
  assert.deepEqual((await fsp.readdir(directory)).sort(), [name, "save.tmp"].sort());
  report.cases.push({ test: "real-rename", sync, policy: renameIdentity ?? "default",
    basenameLength: length, customPrefix: tempPrefix !== undefined,
    drifted, outcome, sha256: digest(bytes), noStagingOrLockLeftovers: true });
}

async function substitutedPublication(sync, renameIdentity, replacement) {
  const directory = await freshCase();
  const filePath = path.join(directory, "configuration.json");
  const retained = path.join(directory, "retained");
  const fileSystem = sync ? {
    ...fs,
    renameSync(source, destination) {
      fs.renameSync(source, retained);
      fs.writeFileSync(destination, replacement, { flag: "wx", mode: 0o777 });
    },
  } : { promises: {
    ...fsp,
    async rename(source, destination) {
      await fsp.rename(source, retained);
      await fsp.writeFile(destination, replacement, { flag: "wx", mode: 0o777 });
    },
  } };
  const outcome = await invoke(sync, { filePath, content, renameIdentity, fileSystem });
  assert.equal(outcome, renameIdentity === "verify-content-with-lock" && replacement === content
    ? "rename" : "path-mismatch");
  assert.notEqual(identity(await fsp.stat(retained, { bigint: true })),
    identity(await fsp.stat(filePath, { bigint: true })));
  assert.equal(await fsp.readFile(filePath, "utf8"), replacement);
  assert.equal(await fsp.readFile(retained, "utf8"), content);
  assert.deepEqual((await fsp.readdir(directory)).sort(), ["configuration.json", "retained"]);
  report.cases.push({ test: "controlled-substitution", sync,
    policy: renameIdentity ?? "default", identicalBytes: replacement === content,
    outcome, substitutedFilePreserved: true, lockRemoved: true });
}

async function callbackPrefixIsolation() {
  const directory = await freshCase();
  const sentinel = path.join(directory, "save.tmp");
  await fsp.writeFile(sentinel, "unrelated", { flag: "wx" });
  const paths = new Set();
  const outcomes = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const output = path.join(directory, `callback-${index}.json`);
    try {
      await writeSiblingTempFile({ dir: directory, tempPrefix: "save",
        writeTemp: async (tempPath) => {
          assert.notEqual(tempPath, sentinel);
          assert.ok(!paths.has(tempPath));
          paths.add(tempPath);
          await fsp.writeFile(tempPath, String(index));
        },
        resolveFinalPath: () => output,
      });
      return "rename";
    } catch (error) {
      // Callback publication remains strict; FAT drift can reject after rename.
      assert.equal(error.code, "path-mismatch");
      return error.code;
    } finally {
      assert.equal(await fsp.readFile(output, "utf8"), String(index));
    }
  }));
  assert.equal(paths.size, 8);
  assert.equal(await fsp.readFile(sentinel, "utf8"), "unrelated");
  assert.equal((await fsp.readdir(directory)).length, 9);
  report.cases.push({ test: "concurrent-callback-prefix", writers: 8,
    outcomes, uniqueStages: paths.size, sentinelPreserved: true });
}

async function invalidPrefixes() {
  const directory = await freshCase();
  const filePath = path.join(directory, "configuration.json");
  for (const tempPrefix of ["", ".", "..", "bad\0prefix", "bad/name", "bad\\name"]) {
    for (const sync of [false, true]) {
      await assert.rejects(() => invoke(sync, { filePath, content, tempPrefix }),
        { code: "invalid-path" });
    }
    await assert.rejects(() => writeSiblingTempFile({ dir: directory, tempPrefix,
      writeTemp: async () => assert.fail("invalid prefix reached producer"),
      resolveFinalPath: () => filePath,
    }), { code: "invalid-path" });
  }
  assert.deepEqual(await fsp.readdir(directory), []);
  report.cases.push({ test: "invalid-prefixes", assertions: 18, noFilesCreated: true });
}

async function symlinkPrefixIsolation() {
  const directory = await freshCase();
  const referent = path.join(directory, "referent");
  const sentinel = path.join(directory, "save.tmp");
  await fsp.writeFile(referent, "unrelated", { flag: "wx" });
  try {
    await fsp.symlink(referent, sentinel, "file");
  } catch (error) {
    const unsupported = ["EPERM", "ENOTSUP"].includes(error.code) ||
      (process.platform === "win32" && error.code === "EISDIR");
    if (!unsupported) throw error;
    report.cases.push({ test: "symlink-prefix", skipped: error.code });
    return;
  }
  for (const sync of [false, true]) {
    assert.equal(await invoke(sync, { filePath: path.join(directory, `atomic-${sync}`),
      content, tempPrefix: "save", renameIdentity: "verify-content-with-lock" }), "rename");
  }
  try {
    await writeSiblingTempFile({ dir: directory, tempPrefix: "save",
      writeTemp: async (tempPath) => {
        assert.notEqual(tempPath, sentinel);
        await fsp.writeFile(tempPath, content);
      },
      resolveFinalPath: () => path.join(directory, "callback"),
    });
  } catch (error) {
    assert.equal(error.code, "path-mismatch");
  }
  assert.equal(await fsp.readFile(path.join(directory, "callback"), "utf8"), content);
  assert.equal(await fsp.readFile(referent, "utf8"), "unrelated");
  assert.ok((await fsp.lstat(sentinel)).isSymbolicLink());
  report.cases.push({ test: "symlink-prefix", referentPreserved: true, linkPreserved: true });
}

async function concurrentLockedWrites() {
  const directory = await freshCase();
  const filePath = path.join(directory, "configuration.json");
  const stages = new Set();
  await Promise.all(Array.from({ length: 8 }, (_, index) => replaceFileAtomic({
    filePath, content: String(index), tempPrefix: "queue",
    renameIdentity: "verify-content-with-lock",
    beforeRename: ({ tempPath }) => {
      assert.ok(!stages.has(tempPath));
      stages.add(tempPath);
    },
  })));
  assert.equal(stages.size, 8);
  assert.match(await fsp.readFile(filePath, "utf8"), /^[0-7]$/);
  assert.deepEqual(await fsp.readdir(directory), ["configuration.json"]);
  report.cases.push({ test: "concurrent-locked-writes", writers: 8,
    uniqueStages: stages.size, noStagingOrLockLeftovers: true });
}

try {
  for (const sync of [false, true]) {
    for (const policy of [undefined, "strict", "verify-content-with-lock"]) {
      for (const length of [12, 15, 16, 64]) {
        for (const prefix of [undefined, "save"]) {
          await realRename(sync, policy, length, prefix);
        }
      }
      for (const replacement of [content, "tampered"]) {
        await substitutedPublication(sync, policy, replacement);
      }
    }
  }
  await callbackPrefixIsolation();
  await invalidPrefixes();
  await symlinkPrefixIsolation();
  await concurrentLockedWrites();
  report.ok = true;
} finally {
  // Only the newly created child is eligible for recursive cleanup.
  assert.equal(path.dirname(path.resolve(sandbox)), parent);
  assert.equal(await fsp.realpath(sandbox), sandbox);
  await fsp.rm(sandbox, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
