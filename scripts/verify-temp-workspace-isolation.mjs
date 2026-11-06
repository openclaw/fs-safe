import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const script = fileURLToPath(import.meta.url);
const uid = 10001;
const gid = 10001;
const childEnv = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", HOME: "/workspace" };
const [role, serialized] = process.argv.slice(2);
const config = serialized ? JSON.parse(serialized) : undefined;

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", env: childEnv });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed: ${result.error?.code ?? result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function identity(name) {
  const stat = fs.statSync(name, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), uid: Number(stat.uid), mode: Number(stat.mode & 0o7777n) };
}

function digest(name) {
  return createHash("sha256").update(fs.readFileSync(name)).digest("hex");
}

function runtimeDigest(root = fileURLToPath(new URL("../dist/", import.meta.url))) {
  const hash = createHash("sha256");
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(name);
      else hash.update(path.relative(root, name)).update("\0").update(fs.readFileSync(name)).update("\0");
    }
  }
  walk(root);
  return hash.digest("hex");
}

async function stageHostRuntime(base) {
  // The invoking checkout may be private to the runner's login user.
  const runtime = path.join(base, "host-runtime");
  const stagedScript = path.join(runtime, "scripts", path.basename(script));
  fs.mkdirSync(path.dirname(stagedScript), { recursive: true });
  fs.copyFileSync(script, stagedScript);
  fs.copyFileSync(new URL("../package.json", import.meta.url), path.join(runtime, "package.json"));
  fs.cpSync(new URL("../dist/", import.meta.url), path.join(runtime, "dist"), { recursive: true });
  const { readFsSafeNativeStatus } = await import("../dist/native-status.js");
  const { packageName } = readFsSafeNativeStatus();
  if (packageName) {
    let manifest;
    try { manifest = createRequire(import.meta.url).resolve(`${packageName}/package.json`); }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
    if (manifest) fs.cpSync(path.dirname(manifest), path.join(runtime, "node_modules", packageName), { recursive: true });
  }
  const node = path.join(runtime, "node");
  fs.copyFileSync(process.execPath, node);
  function readOnly(name) {
    const stat = fs.lstatSync(name);
    assert.ok(!stat.isSymbolicLink(), "staged runtime must not depend on external symlinks");
    if (stat.isDirectory()) for (const entry of fs.readdirSync(name)) readOnly(path.join(name, entry));
    fs.chmodSync(name, stat.isDirectory() || name === node ? 0o555 : 0o444);
  }
  readOnly(runtime);
  assert.equal(runtimeDigest(path.join(runtime, "dist")), runtimeDigest());
  assert.equal(digest(node), digest(process.execPath));
  return { stagedScript, node };
}

async function host() {
  assert.equal(process.geteuid(), uid);
  const { tempWorkspace } = await import("../dist/temp.js");
  const { configureFsSafeNative } = await import("../dist/native-config.js");
  const { readFsSafeNativeStatus } = await import("../dist/native-status.js");
  configureFsSafeNative({ mode: config.nativeMode });
  await assert.rejects(tempWorkspace({ rootDir: config.rootDir, prefix: "strict-" }), { code: "insecure-permissions" });
  const workspace = await tempWorkspace({
    rootDir: config.rootDir, prefix: "reference-", trustedWritableAncestors: [config.volume],
  });
  let running = true;
  let operations = 0;
  const io = (async () => {
    while (running) {
      const value = `trusted-${operations++}`;
      await workspace.writeText("pulse", value);
      assert.equal((await workspace.read("pulse")).toString(), value);
      await delay(10);
    }
  })();
  io.catch(() => { process.exitCode = 1; });
  const native = readFsSafeNativeStatus();
  const nativeBindingSha256 = native.loaded ? digest(createRequire(import.meta.url).resolve(native.packageName)) : null;
  process.send({ type: "ready", dir: workspace.dir, identity: identity(workspace.dir), nativeLoaded: native.loaded, nativeBindingSha256 });
  process.once("message", async (message) => {
    if (message !== "stop") return;
    try {
      running = false;
      await io;
      const cleanup = await workspace.cleanup();
      process.send({ type: "stopped", cleanup, operations }, () => process.exit(0));
    } catch {
      process.send({ type: "failed" }, () => process.exit(1));
    }
  });
}

async function attacker() {
  assert.equal(process.geteuid(), uid);
  assert.equal(process.getegid(), gid);
  const status = fs.readFileSync("/proc/self/status", "utf8");
  for (const field of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    assert.match(status, new RegExp(`^${field}:\\s+0+$`, "m"));
  }
  assert.match(status, /^Groups:[ \t]*$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  const { rootDir, workspace } = config;
  const actions = [
    () => fs.renameSync(rootDir, `${rootDir}.replaced`),
    () => fs.rmSync(rootDir, { recursive: true }),
    () => fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 }),
    () => fs.symlinkSync("/workspace", rootDir, "dir"),
    () => fs.renameSync(workspace, `${workspace}.replaced`),
    () => fs.mkdirSync(workspace, { recursive: true, mode: 0o700 }),
    () => fs.renameSync(`/proc/1/root${rootDir}`, `/proc/1/root${rootDir}.replaced`),
    () => fs.mkdirSync(`/proc/self/root${rootDir}`, { recursive: true }),
  ];
  fs.writeFileSync("/workspace/attacker-started", "ready");
  let denied = 0;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    for (const action of actions) {
      assert.throws(action, (error) => {
        assert.ok(["ENOENT", "EACCES", "EPERM", "EROFS", "ENOTDIR"].includes(error.code));
        denied++;
        return true;
      });
    }
    fs.writeFileSync("/workspace/attacker-output", "allowed work succeeded");
    await delay(10);
  }
  process.stdout.write(`${JSON.stringify({ uid: process.geteuid(), denied, allowedWork: true, capabilities: "none", noNewPrivileges: true })}\n`);
}

function sandbox() {
  const { jail, allowed } = config;
  command("mount", ["--make-rprivate", "/"]);
  const directory = (name, mode = 0o755) => fs.mkdirSync(path.join(jail, name), { recursive: true, mode });
  const bind = (source, destination, readonly = true) => {
    command("mount", ["--bind", source, path.join(jail, destination)]);
    if (readonly) command("mount", ["-o", "remount,bind,ro,nosuid,nodev", path.join(jail, destination)]);
  };
  directory("usr");
  bind("/usr", "usr");
  for (const name of ["bin", "lib", "lib64"]) {
    if (!fs.existsSync(`/${name}`)) continue;
    if (fs.lstatSync(`/${name}`).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(`/${name}`), path.join(jail, name));
    else { directory(name); bind(`/${name}`, name); }
  }
  for (const name of ["proc", "proof", "runtime", "workspace", "tmp"]) directory(name);
  fs.chmodSync(path.join(jail, "tmp"), 0o555);
  for (const name of ["proof/reference.mjs", "runtime/node"]) fs.writeFileSync(path.join(jail, name), "");
  bind(script, "proof/reference.mjs");
  bind(process.execPath, "runtime/node");
  bind(allowed, "workspace", false);
  command("mount", ["-t", "proc", "-o", "nosuid,nodev,noexec", "proc", path.join(jail, "proc")]);
  const output = command("chroot", [jail, "/usr/bin/setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups",
    "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
    "/runtime/node", "/proof/reference.mjs", "--attacker", JSON.stringify(config)]);
  process.stdout.write(output);
}

function startHost(settings) {
  const child = fork(settings.stagedScript, ["--host", JSON.stringify(settings)], {
    execPath: settings.node, uid, gid, env: childEnv, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr.on("data", (data) => { diagnostics += data; });
  const waitFor = (type) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`host ${type} timed out`)), 15000);
    const message = (value) => {
      if (value.type === type) finish(undefined, value);
      if (value.type === "failed") finish(new Error("trusted I/O failed"));
    };
    const exit = () => finish(new Error(`host exited before ${type}: ${diagnostics}`));
    function finish(error, value) {
      clearTimeout(timeout);
      child.off("message", message);
      child.off("exit", exit);
      child.off("error", failed);
      error ? reject(error) : resolve(value);
    }
    const failed = (error) => finish(error);
    child.on("message", message);
    child.once("exit", exit);
    child.once("error", failed);
  });
  return { child, ready: waitFor("ready"), async stop() {
    const stopped = waitFor("stopped");
    child.send("stop");
    const result = await stopped;
    assert.equal(result.cleanup, "removed");
    assert.ok(result.operations > 0);
    if (child.exitCode === null) await once(child, "exit");
    assert.equal(child.exitCode, 0);
    return result.operations;
  } };
}

async function terminate(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

function prepare(base, name) {
  const volume = path.join(base, name);
  const rootDir = path.join(volume, "private");
  fs.mkdirSync(volume, { mode: 0o2777 });
  fs.chmodSync(volume, 0o2777);
  fs.mkdirSync(rootDir, { mode: 0o700 });
  fs.chownSync(rootDir, uid, gid);
  return { volume, rootDir };
}

async function verifyReference(base, nativeMode, runtime) {
  const settings = { ...prepare(base, `protected-${nativeMode}`), nativeMode, ...runtime };
  const rootIdentity = identity(settings.rootDir);
  const allowed = path.join(base, `allowed-${nativeMode}`);
  const jail = path.join(base, `jail-${nativeMode}`);
  fs.mkdirSync(allowed, { mode: 0o700 });
  fs.chownSync(allowed, uid, gid);
  fs.mkdirSync(jail, { mode: 0o755 });
  const hosts = [];
  let isolated;
  try {
    const a = startHost(settings); hosts.push(a);
    const first = await a.ready;
    isolated = spawn("unshare", ["--mount", "--pid", "--net", "--ipc", "--uts", "--fork", "--kill-child",
      process.execPath, script, "--sandbox", JSON.stringify({ ...settings, allowed, jail, workspace: first.dir })],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    isolated.stdout.on("data", (data) => { stdout += data; });
    isolated.stderr.on("data", (data) => { stderr += data; });
    let launchError;
    isolated.once("error", (error) => { launchError = error; });
    const exited = once(isolated, "exit");
    // Observe spawn errors immediately, even while awaiting the startup marker.
    exited.catch(() => {});
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(allowed, "attacker-started"))) {
      if (launchError) throw launchError;
      assert.equal(isolated.exitCode, null, `sandbox failed: ${stderr}`);
      assert.ok(Date.now() < deadline, "sandbox startup timed out");
      await delay(20);
    }
    const b = startHost(settings); hosts.push(b);
    const beforeCrash = await b.ready;
    const operations = [await a.stop()];
    assert.equal(isolated.exitCode, null, "attacker must remain active through restart");
    const c = startHost(settings); hosts.push(c);
    await c.ready;
    b.child.kill("SIGKILL");
    await once(b.child, "exit");
    const d = startHost(settings); hosts.push(d);
    await d.ready;
    assert.equal(isolated.exitCode, null, "attacker must remain active through crash recovery");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    const attack = JSON.parse(stdout);
    assert.ok(attack.denied >= 800);
    assert.equal(attack.uid, uid);
    assert.equal(attack.allowedWork, true);
    assert.deepEqual(identity(settings.rootDir), rootIdentity);
    assert.deepEqual(identity(beforeCrash.dir), beforeCrash.identity);
    assert.equal(fs.readFileSync(path.join(allowed, "attacker-output"), "utf8"), "allowed work succeeded");
    operations.push(await c.stop(), await d.stop());
    return { nativeMode, nativeLoaded: first.nativeLoaded, nativeBindingSha256: first.nativeBindingSha256,
      strictDefaultRejected: true, ...attack, trustedOperations: operations.reduce((a, b) => a + b),
      normalRestart: true, crashRecovery: true, overlappingTrustedHosts: true, rootIdentityPreserved: true,
      crashedWorkspacePreserved: true, cleanup: "removed for all normally stopped hosts" };
  } finally {
    await Promise.all([...hosts.map((host) => host.child), isolated].map(terminate));
  }
}

async function main() {
  assert.equal(process.platform, "linux", "reference proof requires a disposable Linux environment");
  assert.equal(process.geteuid(), 0, "reference supervisor needs root to create namespaces and drop worker privileges");
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-isolation-reference-")));
  fs.chmodSync(base, 0o755);
  try {
    const runtime = await stageHostRuntime(base);
    const control = prepare(base, "unsafe");
    const original = identity(control.rootDir);
    const unsafe = spawnSync(runtime.node, ["--input-type=module", "--eval",
      'import fs from "node:fs"; const root = process.argv[1]; fs.renameSync(root, `${root}.retained`); fs.mkdirSync(root, {mode:0o700});',
      control.rootDir], { uid, gid, env: childEnv, encoding: "utf8" });
    assert.equal(unsafe.status, 0, unsafe.stderr);
    assert.notDeepEqual(identity(control.rootDir), original);
    const results = [];
    for (const nativeMode of ["off", "auto"]) results.push(await verifyReference(base, nativeMode, runtime));
    console.log(JSON.stringify({ configuration: "mount-and-pid-namespaces-v1", platform: process.platform,
      arch: process.arch, kernel: os.release(), node: process.version, nodeSha256: digest(process.execPath),
      referenceSha256: digest(script), builtRuntimeSha256: runtimeDigest(),
      sameUidUnsafeControlReplacedRoot: true, results }, null, 2));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

try {
  if (role === "--host") await host();
  else if (role === "--attacker") await attacker();
  else if (role === "--sandbox") sandbox();
  else if (role === undefined) await main();
  else throw new Error("unknown reference proof role");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
