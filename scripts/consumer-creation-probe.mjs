import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindCreationConsumer } from "./consumer-creation-contract.mjs";

const mode = process.argv[2];
assert.ok(["off", "auto", "require"].includes(mode));
const binding = bindCreationConsumer(import.meta.url, mode);
const { configureFsSafeNative, getFsSafeNativeConfig } = await import("@openclaw/fs-safe/config");
const { root } = await import("@openclaw/fs-safe");
const { createDirectory, createDirectorySync, createFileSync } = await import("@openclaw/fs-safe/advanced");
for (const operation of [createDirectory, createDirectorySync, createFileSync]) assert.equal(typeof operation, "function");
configureFsSafeNative({ mode });
assert.deepEqual(getFsSafeNativeConfig(), { mode });
const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(process.cwd(), "creation-proof-")));
const previousUmask = process.platform === "win32" ? undefined : process.umask(0);
const rows = [];
const missingRequired = binding.expected.omitted && mode === "require";
const darwinPrivateUnavailable = process.platform === "darwin" && (binding.expected.omitted || mode === "off");
const privateCreation = !darwinPrivateUnavailable;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (file) => {
  const stat = fs.statSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) };
};
const absent = (file) => assert.throws(() => fs.lstatSync(file), { code: "ENOENT" });

function darwinAclEntries(file) {
  return execFileSync("/bin/ls", ["-lde", file], { encoding: "utf8" })
    .split("\n").filter((line) => /^\s*\d+:/.test(line));
}

function creationPermissions(file, directory, expectedMode = directory ? 0o700 : 0o600, privatePath = true) {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.isDirectory(), directory);
  assert.equal(stat.isFile(), !directory);
  if (process.platform !== "win32") {
    assert.equal(stat.mode & 0o777, expectedMode);
    assert.equal(stat.uid, process.getuid());
    if (process.platform === "darwin" && privatePath) {
      assert.deepEqual(darwinAclEntries(file), [], "private creation retained a Darwin ACL");
      return { kind: "darwin-mode-no-acl", mode: stat.mode & 0o777, currentOwner: true, aclEntries: 0 };
    }
    return { kind: "posix-mode", mode: stat.mode & 0o777, currentOwner: true };
  }
  if (!directory) assert.equal(stat.mode & 0o200, expectedMode & 0o200);
  const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT,
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const raw = JSON.parse(execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./consumer-creation-acl.ps1", import.meta.url)), file],
  { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }));
  assert.equal(raw.owner, raw.current);
  assert.equal(raw.present, true);
  assert.equal(raw.protected, true);
  assert.deepEqual(raw.aces.map((ace) => ace.sid).sort(), [raw.current, "s-1-5-18", "s-1-5-32-544"].sort());
  for (const ace of raw.aces) {
    assert.equal(ace.type, "AccessAllowed");
    assert.equal(ace.mask, 0x1f01ff);
    assert.equal(ace.flags & ~3, 0);
  }
  return { kind: "windows-protected-dacl", currentOwner: true, expectedPrincipalsOnly: true };
}

async function collision(operation, target) {
  const before = identity(target);
  const bytes = fs.statSync(target).isFile() ? fs.readFileSync(target) : undefined;
  await assert.rejects(async () => operation(), { code: "already-exists" });
  assert.deepEqual(identity(target), before);
  if (bytes) assert.deepEqual(fs.readFileSync(target), bytes);
}

async function observeBufferedCreation(target, content, create) {
  let boundaryMissing = 0;
  let boundaryComplete = 0;
  const assertBeforeMutation = () => {
    try {
      assert.deepEqual(fs.readFileSync(target), content, "atomic destination exposed incomplete bytes at a public mutation boundary");
      boundaryComplete++;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      boundaryMissing++;
    }
  };
  const child = fork(new URL("./consumer-creation-observer.mjs", import.meta.url),
    [target, String(content.length), digest(content)], { stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 90_000 });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-16_384); });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let result;
  child.on("message", (message) => { if (message.ready) ready(); else result = message; });
  const failed = new Promise((_resolve, reject) => { child.on("error", reject); });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const stoppedEarly = closed.then(() => { throw new Error(`independent creation observer exited before completion: ${diagnostics}`); });
  try {
    await Promise.race([started, stoppedEarly, failed]);
    await create(assertBeforeMutation);
    assert.equal(child.connected, true, diagnostics);
    child.send({ finished: true });
    const outcome = await Promise.race([closed, failed]);
    assert.equal(outcome.code, 0, diagnostics);
    assert.equal(outcome.signal, null);
    assert.ok(boundaryMissing + boundaryComplete > 0);
    assert.equal(result?.allObservedVisibleBytesComplete, true);
    assert.ok(result.complete > 0);
    return { publicBoundaryObservations: { missing: boundaryMissing, complete: boundaryComplete },
      independentReader: result, observationLimit: "observed values and final bytes; no claim to sample every interleaving" };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

async function proveCreation(capability) {
  if (!missingRequired || process.platform !== "win32") {
    await capability.mkdir("private/nested", { private: privateCreation });
    rows.push({ scenario: `root-${privateCreation ? "private" : "ordinary"}-directory`, parents: ["private", "private/nested"].map((name) =>
      creationPermissions(path.join(sandbox, name), true, privateCreation ? 0o700 : 0o777, privateCreation)) });
  }
  if (missingRequired) {
    for (const [scenario, relative, operation] of [
      ...(process.platform === "win32"
        ? [["require-root-mkdir", "root-directory", () => capability.mkdir("root-directory", { private: true })]] : []),
      ["require-root-create", "root-file", () => capability.create("root-file", "private", { private: true, atomic: true, durable: "file" })],
      ["require-root-create-json", "root-json", () => capability.createJson("root-json", { value: "private" }, { private: true, atomic: true, durable: "file" })],
      ["require-root-stream", "root-stream", () => capability.create("root-stream",
        (async function* () { yield Buffer.from("private"); })(), { private: true, durable: "file" })],
    ]) {
      const before = fs.readdirSync(sandbox).toSorted();
      await assert.rejects(operation, { code: "helper-unavailable" });
      absent(path.join(sandbox, relative));
      assert.deepEqual(fs.readdirSync(sandbox).toSorted(), before);
      rows.push({ scenario, code: "helper-unavailable", mutated: false });
    }
  } else {
    for (const json of [false, true]) {
      const relative = json ? "json-parent/nested/value.json" : "file-parent/nested/value.txt";
      const target = path.join(sandbox, relative);
      const value = { message: "synthetic private creation", count: 7 };
      const content = json ? `${JSON.stringify(value)}\n` : value.message;
      const requestedMode = json ? 0o600 : 0o400;
      const create = () => json
        ? capability.createJson(relative, value, { private: privateCreation, mode: requestedMode, durable: "file" })
        : capability.create(relative, content, { private: privateCreation, atomic: true, mode: requestedMode, durable: "file" });
      await create();
      assert.equal(fs.readFileSync(target, "utf8"), content);
      const permissions = creationPermissions(target, false, requestedMode, privateCreation);
      const parents = [path.dirname(target), path.dirname(path.dirname(target))]
        .map((parent) => creationPermissions(parent, true, privateCreation ? 0o700 : 0o777, privateCreation));
      await collision(create, target);
      assert.deepEqual(creationPermissions(target, false, requestedMode, privateCreation), permissions);
      rows.push({ scenario: `root-${privateCreation ? "private" : "ordinary"}-${json ? "json" : "file"}`, bytes: Buffer.byteLength(content),
        sha256: digest(content), permissions, parents, collisionPreserved: true, durable: "file", requestedMode });
    }
    for (const json of [false, true]) {
      const relative = json ? "atomic-json/value.json" : "atomic-buffer/value.bin";
      const target = path.join(sandbox, relative);
      fs.mkdirSync(path.dirname(target));
      const value = { value: "x".repeat(2 * 1024 * 1024 + 17) };
      const content = json ? Buffer.from(`${JSON.stringify(value)}\n`) : Buffer.alloc(8 * 1024 * 1024 + 37, 0x73);
      const observation = await observeBufferedCreation(target, content, (assertBeforeMutation) => json
        ? capability.createJson(relative, value, { private: privateCreation, mode: 0o600, atomic: true, durable: "file", assertBeforeMutation })
        : capability.create(relative, content, { private: privateCreation, mode: 0o600, atomic: true, durable: "file", assertBeforeMutation }));
      assert.deepEqual(fs.readFileSync(target), content);
      assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
      await collision(() => json
        ? capability.createJson(relative, value, { private: privateCreation, mode: 0o600, atomic: true, durable: "file" })
        : capability.create(relative, content, { private: privateCreation, mode: 0o600, atomic: true, durable: "file" }), target);
      rows.push({ scenario: json ? "root-atomic-json" : "root-atomic-buffer", bytes: content.length,
        sha256: digest(content), permissions: creationPermissions(target, false, 0o600, privateCreation), collisionPreserved: true,
        durable: "file", ...observation });
    }
    const relative = "stream/value.bin";
    const target = path.join(sandbox, relative);
    fs.mkdirSync(path.dirname(target));
    const parts = [Buffer.alloc(512 * 1024 + 11, 0x61), Buffer.from("complete")];
    let reached;
    const staged = new Promise((resolve) => { reached = resolve; });
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    async function* input() { yield parts[0]; reached(); await released; yield parts[1]; }
    const pending = capability.create(relative, input(), { private: privateCreation, mode: 0o600, durable: "file" });
    try {
      await Promise.race([staged, pending.then(() => { throw new Error("stream finished before its producer was released"); })]);
      absent(target);
    } finally { release(); await pending; }
    const content = Buffer.concat(parts);
    assert.deepEqual(fs.readFileSync(target), content);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["value.bin"]);
    rows.push({ scenario: "root-stream-publication", absentWhileProducerPaused: true,
      bytes: content.length, sha256: digest(content), permissions: creationPermissions(target, false, 0o600, privateCreation), durable: "file" });
  }

  for (const [kind, create] of [["async", createDirectory], ["sync", createDirectorySync]]) {
    const target = path.join(sandbox, `leaf-${kind}`);
    if (missingRequired && process.platform === "win32") {
      await assert.rejects(async () => create(target, { private: true }), { code: "helper-unavailable" });
      absent(target);
      rows.push({ scenario: `require-directory-${kind}`, code: "helper-unavailable", mutated: false });
      continue;
    }
    await create(target, { private: privateCreation, mode: 0o700 });
    const permissions = creationPermissions(target, true, 0o700, privateCreation);
    fs.writeFileSync(path.join(target, "sentinel"), "unchanged");
    await collision(() => create(target, { private: privateCreation, mode: 0o700 }), target);
    assert.deepEqual(fs.readdirSync(target), ["sentinel"]);
    assert.equal(fs.readFileSync(path.join(target, "sentinel"), "utf8"), "unchanged");
    assert.deepEqual(creationPermissions(target, true, 0o700, privateCreation), permissions);
    const missingParent = path.join(sandbox, `missing-${kind}`);
    await assert.rejects(async () => create(path.join(missingParent, "child"), { private: privateCreation, mode: 0o700 }));
    absent(missingParent);
    rows.push({ scenario: `advanced-directory-${kind}`, permissions, collisionPreserved: true, recursive: false });
  }
  const target = path.join(sandbox, "owned-file");
  if (missingRequired && process.platform === "win32") {
    assert.throws(() => createFileSync(target, { private: true }), { code: "helper-unavailable" });
    absent(target);
    rows.push({ scenario: "require-file-sync", code: "helper-unavailable", mutated: false });
  } else {
    const descriptors = [];
    for (const method of ["dispose", "close"]) {
      const file = `${target}-${method}`;
      const before = fs.readdirSync(sandbox).toSorted();
      const owner = createFileSync(file, { private: privateCreation, mode: 0o600 });
      const descriptor = owner.fd;
      try {
        assert.ok(Number.isSafeInteger(descriptor) && descriptor >= 0);
        assert.equal(typeof owner.close, "function");
        assert.equal(typeof owner[Symbol.dispose], "function");
        const stat = fs.fstatSync(descriptor, { bigint: true });
        assert.deepEqual({ dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) }, identity(file));
        creationPermissions(file, false, 0o600, privateCreation);
        fs.writeFileSync(descriptor, "owned descriptor bytes");
      } finally { if (method === "dispose") owner[Symbol.dispose](); else owner.close(); }
      assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
      assert.equal(fs.readFileSync(file, "utf8"), "owned descriptor bytes");
      const permissions = creationPermissions(file, false, 0o600, privateCreation);
      await collision(() => createFileSync(file, { private: privateCreation, mode: 0o600 }), file);
      assert.deepEqual(fs.readdirSync(sandbox).toSorted(), [...before, path.basename(file)].toSorted());
      descriptors.push({ method, permissions, descriptorClosed: true, filePreserved: true });
    }
    const missingParent = path.join(sandbox, "missing-file-parent");
    assert.throws(() => createFileSync(path.join(missingParent, "file"), { private: privateCreation, mode: 0o600 }));
    absent(missingParent);
    rows.push({ scenario: "advanced-file-descriptor", descriptors, collisionPreserved: true, recursive: false });
  }
}

async function rejectedPrivateCreations(capability, directory, code) {
  let producerStarted = false;
  const operations = [
    ["root-mkdir", () => capability.mkdir("root-directory/nested", { private: true })],
    ["root-create", () => capability.create("root-file-parent/value", "private", { private: true, atomic: true, durable: "file" })],
    ["root-create-json", () => capability.createJson("root-json-parent/value", { value: "private" }, { private: true, atomic: true, durable: "file" })],
    ["root-stream", () => capability.create("root-stream-parent/value", (async function* () {
      producerStarted = true; yield Buffer.from("private");
    })(), { private: true, durable: "file" })],
    ["directory-async", () => createDirectory(path.join(directory, "directory-async"), { private: true })],
    ["directory-sync", () => createDirectorySync(path.join(directory, "directory-sync"), { private: true })],
    ["file-sync", () => createFileSync(path.join(directory, "file-sync"), { private: true })],
  ];
  const before = fs.readdirSync(directory).toSorted();
  const rejected = [];
  for (const [operation, create] of operations) {
    await assert.rejects(async () => create(), { code });
    assert.deepEqual(fs.readdirSync(directory).toSorted(), before, `${operation} left parents or staging entries`);
    assert.equal(producerStarted, false, "rejected private creation consumed its producer");
    rejected.push({ operation, code, mutated: false });
  }
  return rejected;
}

async function proveDarwinAcls(capability) {
  const parent = path.join(sandbox, "darwin-acl-parent");
  fs.mkdirSync(parent, { mode: 0o700 });
  try {
    execFileSync("/bin/chmod", ["+a", "everyone deny delete", parent]);
    const parentAcl = darwinAclEntries(parent);
    assert.equal(parentAcl.length, 1);
    const child = await root(parent);
    await child.mkdir("nested", { private: true });
    await child.create("value", "synthetic private payload", { private: true, atomic: true });
    rows.push({ scenario: "darwin-noninheriting-parent-acl", parentAclPreserved: true,
      directory: creationPermissions(path.join(parent, "nested"), true),
      file: creationPermissions(path.join(parent, "value"), false) });
    assert.deepEqual(darwinAclEntries(parent), parentAcl);
    fs.rmSync(path.join(parent, "nested"), { recursive: true });
    fs.unlinkSync(path.join(parent, "value"));
    execFileSync("/bin/chmod", ["-N", parent]);
    execFileSync("/bin/chmod", ["+a", "everyone allow read,readattr,file_inherit,directory_inherit", parent]);
    const inheritingAcl = darwinAclEntries(parent);
    assert.equal(inheritingAcl.length, 1);
    const rejected = await rejectedPrivateCreations(child, parent, "insecure-permissions");
    assert.deepEqual(darwinAclEntries(parent), inheritingAcl);
    rows.push({ scenario: "darwin-inheriting-parent-acl-rejected", rejected, parentAclPreserved: true });
  } finally { execFileSync("/bin/chmod", ["-N", parent]); }

  const existing = path.join(sandbox, "darwin-existing-private-directory");
  await createDirectory(existing, { private: true });
  try {
    execFileSync("/bin/chmod", ["+a", "everyone deny delete", existing]);
    const before = { identity: identity(existing), acl: darwinAclEntries(existing) };
    assert.equal(before.acl.length, 1);
    await assert.rejects(() => capability.mkdir(path.basename(existing), { private: true }), { code: "insecure-permissions" });
    assert.deepEqual({ identity: identity(existing), acl: darwinAclEntries(existing) }, before);
    assert.deepEqual(fs.readdirSync(existing), []);
    rows.push({ scenario: "darwin-existing-private-directory-acl-rejected", code: "insecure-permissions", mutated: false });
  } finally { execFileSync("/bin/chmod", ["-N", existing]); }
}

try {
  const capability = await root(sandbox);
  if (darwinPrivateUnavailable) {
    const rejected = await rejectedPrivateCreations(capability, sandbox, "helper-unavailable");
    rows.push(...rejected.map(({ operation, ...result }) => ({ scenario: `darwin-private-${operation}-unavailable`, ...result })));
  }
  if (!darwinPrivateUnavailable || !missingRequired) await proveCreation(capability);
  if (process.platform === "darwin" && !darwinPrivateUnavailable) await proveDarwinAcls(capability);
  const receipt = binding.receipt(rows);
  receipt.permissionObservation = "after public operation returns; creation-time protection requires implementation/race proof";
  receipt.durabilityObservation = "durable:file operations completed and bytes were reread; no power-loss durability claim";
  console.log(JSON.stringify(receipt));
} finally {
  if (previousUmask !== undefined) process.umask(previousUmask);
  try {
    if (process.platform === "win32") {
      await fsp.chmod(path.join(sandbox, "file-parent/nested/value.txt"), 0o600).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } finally { await fsp.rm(sandbox, { recursive: true, force: true }); }
}
