import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { createSecretFileAtomic, writeSecretFileAtomic } from "@openclaw/fs-safe/secret";
import { fileStore } from "@openclaw/fs-safe/store";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";

const mode = process.argv[2];
assert.ok(mode === "off" || mode === "require");
configureFsSafeNative({ mode });
const require = createRequire(import.meta.url);
const expected = JSON.parse(await fs.readFile("expected.json", "utf8"));
const sandbox = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), "secret-proof-")));
const original = { open: fs.open };
const originalSync = { lstatSync: fsSync.lstatSync, realpath: fsSync.realpathSync.native };
const rows = [];

function identity(target) {
  try {
    const stat = originalSync.lstatSync(target, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino), directory: stat.isDirectory() };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function replaceDirectory(target, moved) {
  execFileSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    fs.renameSync(process.argv[1], process.argv[2]);
    fs.mkdirSync(process.argv[1], { mode: 0o700 });
    fs.writeFileSync(process.argv[1] + '/replacement', 'unchanged');
  `, target, moved], { timeout: 10_000, killSignal: "SIGKILL" });
}

function observeOpens(events) {
  fs.open = async (...args) => {
    events.push({ event: "open", path: path.relative(sandbox, String(args[0])), flags: args[1] });
    return await original.open(...args);
  };
}

try {
  for (const [operation, write] of [["write", writeSecretFileAtomic], ["create", createSecretFileAtomic]]) {
    const rootDir = path.join(sandbox, `${operation}-stable`);
    const parent = path.join(rootDir, "parent");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const before = { root: await identity(rootDir), parent: await identity(parent) };
    await write({ rootDir, filePath: path.join(parent, "token"), content: "synthetic package proof" });
    assert.equal(await fs.readFile(path.join(parent, "token"), "utf8"), "synthetic package proof");
    assert.deepEqual({ root: await identity(rootDir), parent: await identity(parent) }, before);
    rows.push({ operation, scenario: "stable", before, published: true });

    for (const component of ["root", "parent"]) {
      const rootDir = path.join(sandbox, `${operation}-${component}`);
      const parent = path.join(rootDir, "parent");
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      const target = component === "root" ? rootDir : parent;
      const moved = `${target}-admitted`;
      await fs.writeFile(path.join(target, "sentinel"), "unchanged");
      const before = await identity(target);
      let inspections = 0;
      let swapped = false;
      const events = [];
      fsSync.lstatSync = (...args) => {
        const stat = originalSync.lstatSync(...args);
        if (String(args[0]) === target && args[1]?.bigint) inspections++;
        return stat;
      };
      fsSync.realpathSync.native = (...args) => {
        // Replace after initial inspection and exact guard capture, before write admission.
        if (String(args[0]) === target && inspections >= 2 && !swapped) {
          replaceDirectory(target, moved);
          swapped = true;
          events.push({ event: "replace-directory", before, after: identity(target) });
        }
        return originalSync.realpath(...args);
      };
      observeOpens(events);
      let failure;
      try {
        await write({ rootDir, filePath: path.join(parent, "token"), content: "must not publish" });
      } catch (error) {
        failure = { name: error.name, code: error.code };
      } finally {
        Object.assign(fs, original);
        fsSync.lstatSync = originalSync.lstatSync;
        fsSync.realpathSync.native = originalSync.realpath;
      }
      assert.ok(swapped, "replacement witness must execute");
      assert.equal(failure?.code, "path-mismatch");
      assert.equal(events.filter((event) => event.event === "open").length, 0);
      assert.deepEqual(await fs.readdir(target), ["replacement"]);
      assert.equal(await fs.readFile(path.join(moved, "sentinel"), "utf8"), "unchanged");
      assert.equal(await identity(path.join(parent, "token")), null);
      rows.push({ operation, scenario: `replace-${component}`, failure, events, published: false });
    }
  }

  for (const scenario of ["stable", "replacement", "deletion"]) {
    const rootDir = path.join(sandbox, `json-${scenario}`);
    const parent = path.join(rootDir, "parent");
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const before = await identity(parent);
    const events = [];
    let inspections = 0;
    let changed = false;
    let callbacks = 0;
    // Queue-key inspection plus preparation; Windows skips the POSIX mode inspection.
    const admittedAfter = process.platform === "win32" ? 5 : 6;
    fsSync.lstatSync = (...args) => {
      if (scenario !== "stable" && String(args[0]) === parent && inspections >= admittedAfter && !changed) {
        if (scenario === "deletion") {
          execFileSync(process.execPath, ["-e", "require('node:fs').rmdirSync(process.argv[1])", parent], {
            timeout: 10_000, killSignal: "SIGKILL",
          });
        } else {
          replaceDirectory(parent, `${parent}-admitted`);
        }
        changed = true;
        events.push({ event: scenario, before, after: identity(parent) });
      }
      const stat = originalSync.lstatSync(...args);
      if (String(args[0]) === parent) inspections++;
      return stat;
    };
    observeOpens(events);
    let failure;
    try {
      const state = fileStore({ rootDir, private: true }).json("parent/state.json", { lock: true });
      await state.updateOr({ count: 0 }, (value) => {
        callbacks++;
        return { count: value.count + 1 };
      });
    } catch (error) {
      failure = { name: error.name, code: error.code };
    } finally {
      Object.assign(fs, original);
      fsSync.lstatSync = originalSync.lstatSync;
      fsSync.realpathSync.native = originalSync.realpath;
    }
    if (scenario === "stable") {
      assert.equal(failure, undefined);
      assert.equal(callbacks, 1);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(parent, "state.json"), "utf8")), { count: 1 });
      assert.deepEqual(await fs.readdir(parent), ["state.json"]);
    } else {
      assert.ok(changed, "parent mutation witness must execute");
      assert.equal(failure?.code, "path-mismatch");
      assert.equal(callbacks, 0);
      assert.equal(events.filter((event) => event.event === "open").length, 0);
      if (scenario === "deletion") assert.equal(await identity(parent), null);
      else assert.deepEqual(await fs.readdir(parent), ["replacement"]);
    }
    rows.push({ operation: "private-json", scenario, before, failure: failure ?? null, callbacks, events });
  }

  const rootManifest = require.resolve("@openclaw/fs-safe/package.json");
  const rootRequire = createRequire(rootManifest);
  const binary = fsSync.realpathSync.native(rootRequire.resolve(expected.host.package));
  const loaded = nativeBinaryLoaded(binary);
  assert.equal(loaded, mode === "require");
  const hash = (file) => createHash("sha256").update(fsSync.readFileSync(file)).digest("hex");
  const modulePath = require.resolve("@openclaw/fs-safe/secret");
  console.log(JSON.stringify({
    platform: process.platform, arch: process.arch, node: process.version, mode,
    module: path.relative(process.cwd(), modulePath), moduleSha256: hash(modulePath),
    compiledModules: Object.fromEntries([
      "secret-file.js", "directory-guard.js", "root-context.js", "native-pinned-write.js", "pinned-write.js", "sidecar-lock-acquire.js",
    ].map((name) => [name, hash(path.join(path.dirname(rootManifest), "dist", name))])),
    binary: path.relative(process.cwd(), binary), binarySha256: hash(binary), nativeLoaded: loaded,
    probeSha256: hash(new URL(import.meta.url)), metadataHelperSha256: hash(new URL("./consumer-proof-metadata.mjs", import.meta.url)),
    metadataProjection: false, separateProcessMutations: true, rows,
  }));
} finally {
  Object.assign(fs, original);
  fsSync.lstatSync = originalSync.lstatSync;
  fsSync.realpathSync.native = originalSync.realpath;
  await fs.rm(sandbox, { recursive: true, force: true });
}
