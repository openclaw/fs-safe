import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.versions.bun, "this qualification must execute under Bun");
const [scenario = "all", packageDirectory = fileURLToPath(new URL("../", import.meta.url))] = process.argv.slice(2);
assert.ok(["all", "auto", "require", "off", "missing-auto", "missing-require"].includes(scenario));
const packageRoot = path.resolve(packageDirectory);
const packageRequire = createRequire(path.join(packageRoot, "package.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const nativePackages = Object.keys(manifest.optionalDependencies).filter((name) => name.startsWith("@openclaw/fs-safe-"));
const runtime = { bun: process.versions.bun, platform: process.platform, arch: process.arch,
  jitless: process.execArgv.includes("--jitless") || process.env.BUN_JSC_useJIT === "false" };
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function child(kind, directory, script = fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, ["--no-install", ...process.execArgv, script, kind, directory], {
    cwd: directory, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined, `${kind}: child failed to execute`);
  assert.equal(result.status, 0, `${kind}: ${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bun, process.versions.bun, "children must use the same Bun runtime");
  assert.equal(report.jitless, runtime.jitless, "children must retain JIT-disabled execution");
  assert.equal(report.scenario, kind);
  assert.equal(report.ok, true);
  return report;
}

if (scenario === "all") {
  const reports = [child("auto", packageRoot), child("require", packageRoot), child("off", packageRoot)];
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "fs-bun-missing-"));
  try {
    // Resolve dependencies from a real external consumer with no native packages.
    fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(consumer, "package.json"));
    fs.cpSync(path.join(packageRoot, "dist"), path.join(consumer, "dist"), { recursive: true });
    const consumerScript = path.join(consumer, "bun-native-proof.mjs");
    fs.copyFileSync(fileURLToPath(import.meta.url), consumerScript);
    reports.push(child("missing-auto", consumer, consumerScript), child("missing-require", consumer, consumerScript));
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ...runtime, ok: true, version: manifest.version,
    canonicalizerSha256: hash(path.join(packageRoot, "dist", "realpath.js")), reports }, null, 2));
} else {
  const mode = scenario.startsWith("missing-") ? scenario.slice("missing-".length) : scenario;
  if (scenario.startsWith("missing-")) {
    assert.equal(fs.existsSync(path.join(packageRoot, "node_modules")), false);
    for (const name of nativePackages) {
      assert.throws(() => packageRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
    }
  }
  // Observe addon load attempts while forwarding every call to the real loader.
  const dlopen = process.dlopen;
  const addonLoads = [];
  process.dlopen = function (module, filename, ...args) {
    addonLoads.push(String(filename));
    return Reflect.apply(dlopen, this, [module, filename, ...args]);
  };
  const load = (file) => import(pathToFileURL(path.join(packageRoot, "dist", file)).href);
  const { configureFsSafeNative, root } = await load("index.js");
  const { safeRealpathSync } = await load("path.js");
  const { createSecretFileAtomic, writeSecretFileAtomic } = await load("secret.js");
  const { acquireFileLock } = await load("file-lock.js");
  const { sha256File } = await load("durability.js");
  const { watch } = await load("watch.js");
  assert.equal(addonLoads.length, 0, "public imports must not load the addon");
  configureFsSafeNative({ mode });
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-bun-")));
  const checks = [];
  try {
    if (scenario === "missing-require") {
      const target = path.join(directory, "hash-input");
      fs.writeFileSync(target, "unchanged");
      await assert.rejects(() => sha256File(target), { code: "helper-unavailable" });
      assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
      assert.deepEqual(fs.readdirSync(directory), ["hash-input"]);
      checks.push("missing required addon refuses hashing and preserves its input");
    } else {
      const safe = await root(directory);
      await safe.write("ordinary", "ordinary payload");
      assert.equal(await safe.readText("ordinary"), "ordinary payload");
      assert.equal(safeRealpathSync(path.join(directory, "ordinary")), path.join(directory, "ordinary"));
      await assert.rejects(() => safe.write("../escape", "forbidden"), { code: "outside-workspace" });
      checks.push("ordinary Root read/write and confinement");
      for (const watchMode of ["node", "poll"]) {
        const hints = [];
        const observer = watch(safe, { mode: watchMode,
          scopes: [{ path: "watch-tree", kind: "tree" }],
          onDirty(hint) { hints.push(hint); },
        });
        try {
          await observer.ready;
          fs.mkdirSync(path.join(directory, "watch-tree"), { recursive: true });
          fs.writeFileSync(path.join(directory, "watch-tree", "file"), watchMode);
          await observer.reconcile();
          assert.equal(observer.health().state, "ready");
          assert.ok(hints.length > 0);
          assert.equal(await safe.readText("watch-tree/file"), watchMode);
        } finally { await observer.close(); }
        assert.equal(observer.health().workers, 0);
        assert.equal(observer.health().directories, 0);
        checks.push("watch " + watchMode + " readiness/reconciliation/joined close");
      }
      const hashed = await sha256File(path.join(directory, "ordinary"));
      assert.deepEqual(hashed, { bytes: Buffer.byteLength("ordinary payload"),
        digest: createHash("sha256").update("ordinary payload").digest("hex") });
      checks.push("SHA-256 preserves the selected native policy");
      if (mode !== "off" && !scenario.startsWith("missing-")) {
        assert.ok(addonLoads.some((file) => file.endsWith(".node")), "native qualification must actually load the addon");
      }
      if (process.platform === "win32" && mode === "require") {
        const { requireNativeBinding } = await load("native.js");
        const binding = requireNativeBinding();
        const rootFd = fs.openSync(directory, fs.constants.O_RDONLY);
        try {
          const rootBefore = fs.fstatSync(rootFd, { bigint: true });
          binding.mkdirBeneath(rootFd, "bun-libuv-directory", 0o700);
          assert.equal(fs.lstatSync(path.join(directory, "bun-libuv-directory")).isDirectory(), true);
          const payload = Buffer.from("bun host libuv descriptor proof");
          fs.writeFileSync(path.join(directory, "bun-libuv-payload"), payload);
          const opened = binding.openBeneath(rootFd, "bun-libuv-payload", fs.constants.O_RDONLY);
          try {
            const received = Buffer.alloc(payload.length);
            assert.equal(fs.readSync(opened.fd, received, 0, received.length, 0), payload.length);
            assert.deepEqual(received, payload);
            const openedStat = fs.fstatSync(opened.fd, { bigint: true });
            assert.equal(openedStat.isFile(), true);
            assert.equal(openedStat.size, BigInt(payload.length));
          } finally { binding.closeOwnedFd(opened.fd); }
          const rootAfter = fs.fstatSync(rootFd, { bigint: true });
          assert.equal(rootAfter.isDirectory(), true);
          assert.equal(rootAfter.dev, rootBefore.dev);
          assert.equal(rootAfter.ino, rootBefore.ino);
        } finally { fs.closeSync(rootFd); }
        assert.ok(addonLoads.some((file) => file.endsWith(".node")));
        checks.push("Windows host libuv converts borrowed and returned native descriptors");
      }
      if (process.platform !== "win32" && mode !== "off" && !scenario.startsWith("missing-")) {
        fs.mkdirSync(path.join(directory, "a"));
        fs.writeFileSync(path.join(directory, "a", "file"), "slash payload");
        const literal = path.join(directory, "a\\file");
        fs.writeFileSync(literal, "literal payload");
        assert.equal(safeRealpathSync(literal), literal);
        assert.equal(await safe.readText("a\\file"), "literal payload");
        await safe.write("a\\file", "literal replacement");
        assert.equal(fs.readFileSync(literal, "utf8"), "literal replacement");
        assert.equal(fs.readFileSync(path.join(directory, "a", "file"), "utf8"), "slash payload");
        checks.push("literal backslash remains distinct from slash path");

        // Public ordinary resolution intentionally normalizes dot segments first;
        // the internal native variant must preserve the kernel's component walk.
        const { realpathSync } = await load("realpath.js");
        fs.mkdirSync(path.join(directory, "target", "child"), { recursive: true });
        fs.symlinkSync("target/child", path.join(directory, "link"));
        const rawParent = `${directory}/link/..`;
        assert.equal(realpathSync.native(rawParent), path.join(directory, "target"));
        assert.equal(safeRealpathSync(rawParent), directory);
        fs.symlinkSync("link/..", path.join(directory, "indirect"));
        assert.equal(safeRealpathSync(path.join(directory, "indirect")), directory);
        assert.equal(realpathSync.native(path.join(directory, "indirect")), path.join(directory, "target"));
        checks.push("symlink before parent preserves both resolution contracts");

        const socket = path.join(directory, "socket");
        const server = createServer();
        try {
          await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
          assert.equal(safeRealpathSync(socket), socket);
          assert.equal(realpathSync.native(socket), socket);
          assert.ok(fs.lstatSync(socket).isSocket());
        } finally {
          if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
        checks.push("socket canonicalizes without a data-file open");

        assert.notEqual(process.getuid?.(), 0, "restrictive-permission proof must run as a non-root user");
        for (const permissions of [0o000, 0o200]) {
          const target = path.join(directory, `secret-${permissions}`);
          try {
            await createSecretFileAtomic({ rootDir: directory, filePath: target, content: "secret payload", mode: permissions });
            assert.equal(safeRealpathSync(target), target);
            assert.equal(fs.statSync(target).mode & 0o777, permissions);
            assert.throws(() => fs.readFileSync(target), { code: "EACCES" });
            await writeSecretFileAtomic({ rootDir: directory, filePath: target, content: "replacement secret", mode: permissions });
            assert.equal(fs.statSync(target).mode & 0o777, permissions);
            fs.chmodSync(target, 0o600);
            assert.equal(fs.readFileSync(target, "utf8"), "replacement secret");
          } finally {
            if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
          }
        }
        checks.push("secret publication and replacement preserve mode 000/200");

        const search = path.join(directory, "search");
        const searchedFile = path.join(search, "MixedCase");
        fs.mkdirSync(search);
        fs.writeFileSync(searchedFile, "unreadable", { mode: 0o000 });
        const caseAlias = path.join(search, "mixedcase");
        const caseInsensitive = fs.existsSync(caseAlias);
        fs.chmodSync(search, 0o100);
        try {
          assert.equal(safeRealpathSync(search), search);
          assert.equal(safeRealpathSync(searchedFile), searchedFile);
          if (caseInsensitive) assert.equal(realpathSync.native(caseAlias), searchedFile);
          assert.equal(fs.statSync(search).mode & 0o777, 0o100);
          assert.equal(fs.statSync(searchedFile).mode & 0o777, 0);
          assert.throws(() => fs.readdirSync(search), { code: "EACCES" });
          fs.chmodSync(search, 0);
          assert.throws(() => realpathSync.native(searchedFile), { code: "EACCES" });
        } finally {
          fs.chmodSync(search, 0o700);
          fs.chmodSync(searchedFile, 0o600);
        }
        checks.push("search-only directory and inaccessible-parent distinction");

        const lockTarget = path.join(directory, "ordinary");
        const lock = await acquireFileLock(lockTarget, { payload: () => ({ owner: "bun-proof" }), retry: { retries: 0 } });
        try {
          const before = fs.statSync(`${lockTarget}.lock`, { bigint: true });
          for (let i = 0; i < 100; i++) assert.equal(safeRealpathSync(lockTarget), lockTarget);
          const after = fs.statSync(`${lockTarget}.lock`, { bigint: true });
          assert.equal(after.dev, before.dev);
          assert.equal(after.ino, before.ino);
        } finally { await lock.release(); }
        assert.equal(fs.existsSync(`${lockTarget}.lock`), false);
        checks.push("sidecar lock retains identity through canonicalization and releases");
      }
    }
    if (mode === "off" || scenario.startsWith("missing-")) {
      assert.equal(addonLoads.length, 0, "off/missing-addon proof must never dlopen an addon");
      checks.push("no native addon load");
    }
    console.log(JSON.stringify({ ...runtime, scenario, mode, ok: true, checks,
      addonLoads: addonLoads.map((file) => ({ file: path.basename(file), sha256: hash(file) })) }));
  } finally {
    process.dlopen = dlopen;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
