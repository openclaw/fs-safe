import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { createPrivateDirectory, readOwnerAndDacl } from "@openclaw/fs-safe/permissions";
import { readSecureFile } from "@openclaw/fs-safe/secure-file";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";

// This file is copied into disposable consumers and uses only public subpaths.
assert.equal(process.platform, "win32");
const mode = process.argv[2];
assert.ok(["off", "auto", "require"].includes(mode));
const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
assert.equal(expected.windowsSecurity.protocol, 2);
assert.ok(expected.omitted || mode === "require");
assert.ok(["npm", "pnpm"].includes(expected.manager.name));
const missingRequired = expected.omitted && mode === "require";
configureFsSafeNative({ mode });
assert.deepEqual(getFsSafeNativeConfig(), { mode });

const require = createRequire(import.meta.url);
const consumer = fs.realpathSync.native(process.cwd());
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function inside(file) {
  const resolved = fs.realpathSync.native(file);
  const relative = path.relative(consumer, resolved);
  assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return resolved;
}
const rootManifest = inside(require.resolve("@openclaw/fs-safe/package.json"));
const rootDirectory = path.dirname(rootManifest);
const rootRequire = createRequire(rootManifest);
assert.deepEqual(JSON.parse(fs.readFileSync(rootManifest, "utf8")), expected.rootPkg);
const entrySha256 = hash(inside(require.resolve("@openclaw/fs-safe")));
assert.equal(entrySha256, expected.entryHash);
assert.match(expected.rootIntegrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
const lockfile = fs.readFileSync(expected.manager.name === "npm" ? "package-lock.json" : "pnpm-lock.yaml", "utf8");
assert.ok(lockfile.includes(expected.rootIntegrity));
const subpaths = Object.fromEntries([
  ["config", "config.js"], ["permissions", "permissions-public.js"], ["secure-file", "secure-file.js"],
].map(([name, compiled]) => {
  const resolved = inside(require.resolve(`@openclaw/fs-safe/${name}`));
  assert.equal(resolved, fs.realpathSync.native(path.join(rootDirectory, "dist", compiled)));
  return [name, path.relative(consumer, resolved)];
}));
const compiledNames = [
  "bounded-read.js", "byte-budget.js", "config.js", "device-path.js", "effective-uid.js",
  "error-detail.js", "errors.js", "file-observation.js", "local-file-access.js", "lock-config.js",
  "native-binding.js", "native-config.js", "native-fallback-warning.js", "native.js", "owner-dacl.js",
  "path.js", "permission-exec.js", "permissions-public.js", "permissions-windows.js", "permissions.js",
  "private-directory.js", "read-open-flags.js", "realpath.js", "safe-path-segment.js", "secure-file-windows.js",
  "secure-file.js", "strict-file-identity.js", "string-coerce.js", "timing.js", "windows-command.js",
  "windows-owner.js", "windows-path-alias.js", "windows-security-command.js", "windows-security-facts.js",
];
assert.deepEqual(Object.keys(expected.windowsSecurity.compiledSha256).sort(), compiledNames.toSorted());
const compiledModules = Object.fromEntries(Object.keys(expected.windowsSecurity.compiledSha256).map((name) => {
  assert.match(name, /^[a-z0-9-]+\.js$/);
  return [name, hash(inside(path.join(rootDirectory, "dist", name)))];
}));
assert.deepEqual(compiledModules, expected.windowsSecurity.compiledSha256);
const scriptAssetNames = ["windows-security-bridge.cs", "windows-security-bridge.ps1"];
assert.deepEqual(Object.keys(expected.windowsSecurity.assetsSha256).sort(), scriptAssetNames);
const scriptAssets = Object.fromEntries(scriptAssetNames.map((name) =>
  [name, hash(inside(path.join(rootDirectory, "dist", name)))]));
assert.deepEqual(scriptAssets, expected.windowsSecurity.assetsSha256);
const bridgeScript = inside(path.join(rootDirectory, "dist", "windows-security-bridge.ps1"));
const bridgeScriptRelative = path.relative(consumer, bridgeScript);
const probeSha256 = hash(new URL(import.meta.url));
const metadataHelperSha256 = hash(new URL("./consumer-proof-metadata.mjs", import.meta.url));
assert.equal(probeSha256, expected.windowsSecurity.probeSha256);
assert.equal(metadataHelperSha256, expected.metadataHelperSha256);

assert.equal(expected.platforms.length, 7);
assert.equal(new Set(expected.platforms).size, 7);
const physical = new Set();
function inspectPackages(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspectPackages(file);
    if (entry.isFile() && entry.name === "package.json") {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (expected.platforms.includes(pkg.name)) physical.add(pkg.name);
    }
  }
}
inspectPackages(path.join(consumer, "node_modules"));
assert.deepEqual([...physical].sort(), expected.omitted ? [] : [expected.host.package]);
let binary;
const resolution = Object.fromEntries(expected.platforms.map((name) => {
  if (!expected.omitted && name === expected.host.package) {
    binary = inside(rootRequire.resolve(name));
    assert.equal(hash(binary), expected.hostBinarySha256);
    return [name, "present"];
  }
  assert.throws(() => rootRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
  return [name, "absent"];
}));
function nativeLoaded() {
  if (binary) return nativeBinaryLoaded(binary);
  assert.deepEqual(process.report.getReport().sharedObjects.filter((file) => file.endsWith(".node")), []);
  return false;
}
assert.equal(nativeLoaded(), false);

const original = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, open: fsp.open };
const commands = [];
const reads = [];
const warnings = [];
let afterOpen;
const warningFeatures = ["windows-owner-dacl", "windows-private-directory", "windows-secure-file"];
const onWarning = (warning) => warnings.push({ code: warning.code ?? null, name: warning.name,
  feature: warningFeatures.find((feature) => warning.message.includes(feature)) ?? null });
process.on("warning", onWarning);
function observedCommandArgs(args) {
  assert.equal(args[4], bridgeScript, "production helper must execute the verified installed script");
  return args.map((value, index) => index === 4 ? bridgeScriptRelative : value);
}
childProcess.spawn = (...args) => {
  const started = performance.now();
  const stdin = args[2]?.stdio?.[0];
  const stat = typeof stdin === "number" ? fs.fstatSync(stdin, { bigint: true }) : undefined;
  const row = { command: path.basename(String(args[0])), args: observedCommandArgs(args[1]), kind: "async", durationMs: null,
    stdin: typeof stdin === "number" ? "inherited-file-descriptor" : stdin,
    inheritedFd: typeof stdin === "number" ? stdin : null,
    inheritedIdentity: stat ? { dev: String(stat.dev), ino: String(stat.ino) } : null };
  commands.push(row);
  const child = original.spawn(...args);
  row.pid = child.pid;
  child.once("close", (code, signal) => Object.assign(row, { durationMs: performance.now() - started, code, signal }));
  return child;
};
childProcess.spawnSync = (...args) => {
  const started = performance.now();
  const result = original.spawnSync(...args);
  commands.push({ command: path.basename(String(args[0])), args: observedCommandArgs(args[1]), kind: "sync", durationMs: performance.now() - started,
    stdin: args[2]?.stdio?.[0], pid: result.pid, code: result.status, signal: result.signal });
  return result;
};
fsp.open = async (...args) => {
  const handle = await original.open(...args);
  for (const method of ["read", "readFile"]) {
    const call = handle[method];
    handle[method] = function (...values) {
      reads.push({ method, fd: handle.fd });
      return call.apply(this, values);
    };
  }
  if (afterOpen) {
    try { await afterOpen(handle, args); }
    catch (error) { await handle.close(); throw error; }
  }
  return handle;
};
syncBuiltinESMExports();

// Independent fixture/query code observes the OS descriptor, not fs-safe output.
// RawSecurityDescriptor preserves ACE order and flags without access-rule normalization.
const aclSource = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ConsumerRawSecurity {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string name,int kind,uint sections,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static byte[] Read(string path) {
    IntPtr owner,group,dacl,sacl,descriptor;
    uint error=GetNamedSecurityInfoW(path,1,5,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0) throw new Win32Exception((int)error);
    try {
      if(descriptor==IntPtr.Zero || owner==IntPtr.Zero) throw new Exception("descriptor incomplete");
      uint length=GetSecurityDescriptorLength(descriptor);
      if(length<20 || length>1048576) throw new Exception("descriptor length invalid");
      var bytes=new byte[length];Marshal.Copy(descriptor,bytes,0,(int)length);return bytes;
    } finally {if(descriptor!=IntPtr.Zero) LocalFree(descriptor);}
  }
}
`;
const aclScript = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'consumer-raw-security.cs')
$p=[Environment]::GetEnvironmentVariable('FS_SAFE_SECURITY_PROOF_PATH')
$action=[Environment]::GetEnvironmentVariable('FS_SAFE_SECURITY_PROOF_ACTION')
if($action -in @('parent','broad','broad-write')) {
  $acl=Get-Acl -LiteralPath $p
  $sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $inherit=if($action -eq 'parent'){[Security.AccessControl.InheritanceFlags]3}else{[Security.AccessControl.InheritanceFlags]0}
  $rights=if($action -eq 'broad-write'){[Security.AccessControl.FileSystemRights]::Write}else{[Security.AccessControl.FileSystemRights]::ReadAndExecute}
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl
}
$raw=[Security.AccessControl.RawSecurityDescriptor]::new([ConsumerRawSecurity]::Read($p),0)
$current=[Security.Principal.WindowsIdentity]::GetCurrent()
try {$currentSid=$current.User.Value.ToLowerInvariant()}finally{$current.Dispose()}
$aces=@();$unsupported=@()
foreach($ace in $raw.DiscretionaryAcl) {
  if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or [int]$ace.AceType -notin @(0,1)) {$unsupported+=([int]$ace.AceType);continue}
  $f=[int]$ace.AceFlags
  $aces+=@{sid=$ace.SecurityIdentifier.Value.ToLowerInvariant();mask=[uint32]([long]$ace.AccessMask -band 4294967295);aceType=$(if([int]$ace.AceType -eq 0){'allow'}else{'deny'});flags=@{
    raw=$f;objectInherit=($f -band 1)-ne 0;containerInherit=($f -band 2)-ne 0;noPropagateInherit=($f -band 4)-ne 0;
    inheritOnly=($f -band 8)-ne 0;inherited=($f -band 16)-ne 0;successfulAccess=($f -band 64)-ne 0;failedAccess=($f -band 128)-ne 0}}
}
@{ownerSid=$raw.Owner.Value.ToLowerInvariant();currentUserSid=$currentSid;daclPresent=($null -ne $raw.DiscretionaryAcl);
  daclProtected=([int]$raw.ControlFlags -band 4096)-ne 0;complete=($unsupported.Count -eq 0);unsupportedAceTypes=@($unsupported);aces=@($aces)}|ConvertTo-Json -Depth 8 -Compress
`;
const powershell = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function independentAcl(target, action = "inspect") {
  const result = original.spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", aclScriptFile], {
    encoding: "utf8", windowsHide: true, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    env: { ...process.env, FS_SAFE_SECURITY_PROOF_PATH: target, FS_SAFE_SECURITY_PROOF_ACTION: action },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "Independent Windows ACL fixture failed while running its readable PowerShell file. " +
    "The fixture obeys the system execution policy; a policy denial prevents this proof from running.\n" +
    (result.stderr.trim() || result.stdout.trim() || `PowerShell exited with status ${result.status}, signal ${result.signal}`));
  const raw = JSON.parse(result.stdout.trim());
  assert.equal(raw.complete, true);
  assert.equal(raw.daclPresent, true);
  assert.deepEqual(raw.unsupportedAceTypes, []);
  return raw;
}
function identity(file) {
  const stat = fs.statSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink), size: String(stat.size) };
}
function publicFacts(raw) {
  const { daclProtected: _, ...facts } = raw;
  return { status: "supported", isLocal: true, ...facts };
}
function assertPrivate(raw, inherited) {
  if (inherited) assert.ok([raw.currentUserSid, "s-1-5-18", "s-1-5-32-544"].includes(raw.ownerSid));
  else assert.equal(raw.ownerSid, raw.currentUserSid);
  assert.equal(raw.aces.length, 3);
  assert.deepEqual(raw.aces.map((ace) => ace.sid).sort(), [raw.currentUserSid, "s-1-5-18", "s-1-5-32-544"].sort());
  for (const ace of raw.aces) {
    assert.equal(ace.aceType, "allow");
    assert.equal(ace.mask, 0x1f01ff);
    assert.deepEqual(ace.flags, {
      raw: inherited ? 16 : 3, objectInherit: !inherited, containerInherit: !inherited,
      noPropagateInherit: false, inheritOnly: false, inherited, successfulAccess: false, failedAccess: false,
    });
  }
  if (!inherited) assert.equal(raw.daclProtected, true);
}
const rows = [];
function measureSync(call) {
  const started = performance.now();
  const result = call();
  return { result, durationMs: performance.now() - started };
}
async function measureAsync(call) {
  const started = performance.now();
  const result = await call();
  return { result, durationMs: performance.now() - started };
}
async function operation(scenario, call) {
  const started = performance.now();
  const commandStart = commands.length;
  const readStart = reads.length;
  const detail = await call();
  rows.push({ scenario, durationMs: performance.now() - started, commands: commands.slice(commandStart),
    contentReadCalls: reads.length - readStart,
    contentReadDescriptors: [...new Set(reads.slice(readStart).map((read) => read.fd))], ...detail });
}
async function failure(call, code) {
  const readStart = reads.length;
  let caught;
  try { await call(); } catch (error) { caught = error; }
  assert.equal(caught?.code, code);
  assert.equal(reads.length, readStart, "failed permission admission must not read file contents");
  return { code: caught.code, causeCode: caught.cause?.code ?? null };
}

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(consumer, "windows-security-proof-")));
const aclScriptFile = path.join(sandbox, "consumer-raw-security.ps1");
try {
  const file = path.join(sandbox, "require-secret.txt");
  if (missingRequired) {
    fs.writeFileSync(file, "synthetic strict secret");
    const before = identity(file);
    const target = path.join(sandbox, "must-not-create");
    await operation("require-owner-fails-closed", async () => ({ failure: await failure(() => readOwnerAndDacl(file), "helper-unavailable") }));
    await operation("require-private-directory-fails-closed", async () => {
      const error = await failure(() => createPrivateDirectory(target), "helper-unavailable");
      assert.equal(fs.existsSync(target), false);
      return { failure: error, targetAbsent: true };
    });
    await operation("require-secure-read-fails-closed", async () => {
      const error = await failure(() => readSecureFile({ filePath: file }), "permission-unverified");
      assert.equal(error.causeCode, "helper-unavailable");
      return { failure: error };
    });
    assert.deepEqual(identity(file), before);
    assert.equal(fs.readFileSync(file, "utf8"), "synthetic strict secret");
    assert.deepEqual(commands, []);
    assert.deepEqual(reads, []);
  } else {
    fs.writeFileSync(path.join(sandbox, "consumer-raw-security.cs"), aclSource, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(aclScriptFile, aclScript, { encoding: "utf8", flag: "wx" });
    const parentAcl = independentAcl(sandbox, "parent");
    assert.ok(parentAcl.aces.some((ace) => ace.sid === "s-1-1-0" && ace.aceType === "allow" && ace.flags.objectInherit));
    const directory = path.join(sandbox, "private-é-🦀");
    await operation("private-directory-created", async () => {
      const measured = await measureAsync(() => createPrivateDirectory(directory));
      return { created: fs.statSync(directory).isDirectory(), publicCallDurationMs: measured.durationMs };
    });
    assert.equal(rows.at(-1).created, true);
    const directoryAcl = independentAcl(directory);
    assertPrivate(directoryAcl, false);
    const repeatedDirectory = path.join(sandbox, "private-repeat-é-🦀");
    await operation("private-directory-created-repeat", async () => {
      const measured = await measureAsync(() => createPrivateDirectory(repeatedDirectory));
      assert.equal(fs.statSync(repeatedDirectory).isDirectory(), true);
      return { created: true, publicCallDurationMs: measured.durationMs };
    });
    assertPrivate(independentAcl(repeatedDirectory), false);
    await operation("raw-owner-and-dacl", async () => {
      const { result: facts, durationMs } = measureSync(() => readOwnerAndDacl(directory));
      assert.deepEqual(facts, publicFacts(directoryAcl));
      return { facts, publicCallDurationMs: durationMs, independentRawFacts: directoryAcl, observed: "after-create-return", parentBroadGrantExcluded: true };
    });
    await operation("raw-owner-and-dacl-repeat", async () => {
      const { result: facts, durationMs } = measureSync(() => readOwnerAndDacl(directory));
      assert.deepEqual(facts, publicFacts(directoryAcl));
      return { facts, publicCallDurationMs: durationMs };
    });
    const beforeDirectory = identity(directory);
    await operation("private-directory-collision", async () => {
      const error = await failure(() => createPrivateDirectory(directory), "EEXIST");
      assert.deepEqual(identity(directory), beforeDirectory);
      return { failure: error, existingDirectoryPreserved: true };
    });
    assert.deepEqual(independentAcl(directory), directoryAcl);
    const secret = path.join(directory, "credential.txt");
    const content = "synthetic installed-package credential";
    fs.writeFileSync(secret, content);
    const fileAcl = independentAcl(secret);
    assertPrivate(fileAcl, true);
    const beforeFile = identity(secret);
    const populatedDirectoryBefore = identity(directory);
    await operation("populated-private-directory-collision", async () => {
      const error = await failure(() => createPrivateDirectory(directory), "EEXIST");
      assert.deepEqual(identity(directory), populatedDirectoryBefore);
      assert.deepEqual(identity(secret), beforeFile);
      assert.deepEqual(fs.readdirSync(directory), ["credential.txt"]);
      assert.equal(fs.readFileSync(secret, "utf8"), content);
      return { failure: error, existingFilePreserved: true };
    });
    assert.deepEqual(independentAcl(directory), directoryAcl);
    await operation("descriptor-secure-read", async () => {
      const { result, durationMs } = await measureAsync(() => readSecureFile({ filePath: secret }));
      assert.equal(result.buffer.toString(), content);
      assert.equal(result.permissions?.source, "windows-acl");
      assert.equal(result.permissions.ownerTrusted, true);
      assert.equal(result.permissions.ownerSid, fileAcl.ownerSid);
      for (const key of ["worldReadable", "worldWritable", "groupReadable", "groupWritable"]) assert.equal(result.permissions[key], false);
      assert.deepEqual(identity(secret), beforeFile);
      return { bytes: result.buffer.length, publicCallDurationMs: durationMs, permissions: result.permissions, independentRawFacts: fileAcl, identityPreserved: true };
    });
    assert.ok(rows.at(-1).contentReadCalls > 0);
    await operation("descriptor-secure-read-repeat", async () => {
      const { result, durationMs } = await measureAsync(() => readSecureFile({ filePath: secret }));
      assert.equal(result.buffer.toString(), content);
      assert.equal(result.permissions?.source, "windows-acl");
      assert.equal(result.permissions.ownerTrusted, true);
      for (const key of ["worldReadable", "worldWritable", "groupReadable", "groupWritable"]) assert.equal(result.permissions[key], false);
      assert.deepEqual(identity(secret), beforeFile);
      return { bytes: result.buffer.length, publicCallDurationMs: durationMs, identityPreserved: true };
    });
    assert.ok(rows.at(-1).contentReadCalls > 0);
    const broadAcl = independentAcl(secret, "broad");
    assert.ok(broadAcl.aces.some((ace) => ace.sid === "s-1-1-0" && ace.aceType === "allow" && !ace.flags.inheritOnly && (ace.mask & 1) !== 0));
    await operation("broad-acl-rejected-before-read", async () => ({
      failure: await failure(() => readSecureFile({ filePath: secret }), "insecure-permissions"), independentRawFacts: broadAcl,
    }));
    await operation("explicit-readable-policy", async () => {
      const result = await readSecureFile({ filePath: secret, permissions: { allowReadableByOthers: true } });
      assert.equal(result.buffer.toString(), content);
      assert.equal(result.permissions?.worldReadable, true);
      assert.equal(result.permissions.worldWritable, false);
      assert.deepEqual(identity(secret), beforeFile);
      return { bytes: result.buffer.length, identityPreserved: true, worldReadable: true };
    });
    assert.ok(rows.at(-1).contentReadCalls > 0);
    const writableAcl = independentAcl(secret, "broad-write");
    assert.ok(writableAcl.aces.some((ace) => ace.sid === "s-1-1-0" && ace.aceType === "allow" && !ace.flags.inheritOnly && (ace.mask & 2) !== 0));
    await operation("broad-write-rejected-with-readable-opt-in", async () => ({
      failure: await failure(() => readSecureFile({ filePath: secret, permissions: { allowReadableByOthers: true } }), "insecure-permissions"),
      independentRawFacts: writableAcl,
    }));
    assert.equal(fs.readFileSync(secret, "utf8"), content);
    assert.deepEqual(fs.readdirSync(directory), ["credential.txt"]);

    const replacedPath = path.join(directory, "replace-before-admission.txt");
    const heldPath = path.join(directory, "held-original.txt");
    const originalContent = "synthetic original retained through replacement";
    const replacementContent = "synthetic replacement remains unread";
    fs.writeFileSync(replacedPath, originalContent);
    const beforeReplacement = identity(replacedPath);
    assert.notEqual(beforeReplacement.dev, "0");
    assert.notEqual(beforeReplacement.ino, "0");
    let replacementWitness;
    let replacementHandle;
    afterOpen = (handle, args) => {
      assert.equal(String(args[0]), replacedPath);
      assert.equal(replacementWitness, undefined);
      const held = fs.fstatSync(handle.fd, { bigint: true });
      replacementHandle = handle;
      assert.deepEqual({ dev: String(held.dev), ino: String(held.ino) },
        { dev: beforeReplacement.dev, ino: beforeReplacement.ino });
      // Mutate real directory entries in another process and return the same
      // original FileHandle. No metadata, API result, or ACL facts are replaced.
      const mutated = original.spawnSync(process.execPath, ["--eval", `
        const fs = require('node:fs');
        fs.renameSync(process.argv[1], process.argv[2]);
        fs.writeFileSync(process.argv[1], process.argv[3]);
      `, replacedPath, heldPath, replacementContent], {
        encoding: "utf8", windowsHide: true, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      if (mutated.error) throw mutated.error;
      assert.equal(mutated.status, 0, mutated.stderr);
      replacementWitness = { openedFd: handle.fd, before: beforeReplacement,
        originalAfter: identity(heldPath), replacement: identity(replacedPath), mutationProcess: { pid: mutated.pid, exitCode: mutated.status } };
      const heldAfter = fs.fstatSync(handle.fd, { bigint: true });
      assert.deepEqual({ dev: heldAfter.dev, ino: heldAfter.ino }, { dev: held.dev, ino: held.ino });
      assert.deepEqual(replacementWitness.originalAfter, beforeReplacement);
      assert.notEqual(replacementWitness.replacement.dev, "0");
      assert.notEqual(replacementWitness.replacement.ino, "0");
      assert.notEqual(replacementWitness.replacement.ino, beforeReplacement.ino);
    };
    try {
      await operation("replaced-path-rejected-before-read", async () => {
        const error = await failure(() => readSecureFile({ filePath: replacedPath }), "path-mismatch");
        assert.ok(replacementWitness, "separate-process replacement must execute after the original open");
        assert.equal(replacementHandle.fd, -1, "rejected read must close its real opened handle");
        assert.equal(fs.readFileSync(heldPath, "utf8"), originalContent);
        assert.equal(fs.readFileSync(replacedPath, "utf8"), replacementContent);
        return { failure: error, mutation: replacementWitness, separateProcessMutation: true,
          rejectionBoundary: "pathname association immediately after open", bothFilesPreserved: true, bufferReturned: false, openedHandleClosed: true };
      });
      assert.deepEqual(rows.at(-1).commands, []);
    } finally { afterOpen = undefined; }
    fs.unlinkSync(replacedPath);
    fs.unlinkSync(heldPath);
    if (expected.omitted) {
      for (const row of rows) {
        if (row.scenario === "replaced-path-rejected-before-read") {
          assert.deepEqual(row.commands, []);
          assert.equal(row.contentReadCalls, 0);
          continue;
        }
        assert.equal(row.commands.length, 1, `${row.scenario} must use the actual installed fallback`);
        const command = row.commands[0];
        const descriptorScenario = ["descriptor-secure-read", "descriptor-secure-read-repeat", "broad-acl-rejected-before-read", "explicit-readable-policy", "broad-write-rejected-with-readable-opt-in"].includes(row.scenario);
        const operation = descriptorScenario ? "descriptor" : row.scenario.startsWith("raw-owner-and-dacl") ? "path" : "create";
        assert.deepEqual(command.args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", bridgeScriptRelative, "-Operation", operation]);
        if (descriptorScenario) {
          assert.equal(command.stdin, "inherited-file-descriptor");
          assert.deepEqual(command.inheritedIdentity, { dev: beforeFile.dev, ino: beforeFile.ino });
          if (row.contentReadCalls > 0) assert.deepEqual(row.contentReadDescriptors, [command.inheritedFd]);
        } else assert.equal(command.stdin, "ignore");
      }
      for (const command of commands) {
        assert.equal(command.command.toLowerCase(), "powershell.exe");
        assert.equal(command.code, 0);
      }
    } else assert.deepEqual(commands, []);
  }
  await new Promise((resolve) => setImmediate(resolve));
  const loaded = nativeLoaded();
  assert.equal(loaded, !expected.omitted);
  if (expected.omitted && !missingRequired) {
    assert.deepEqual(warnings.map((warning) => warning.feature).sort(), warningFeatures.toSorted());
    for (const warning of warnings) {
      assert.equal(warning.code, "FS_SAFE_NATIVE_FALLBACK");
      assert.equal(warning.name, "FsSafeWarning");
    }
  } else assert.deepEqual(warnings, []);
  console.log(JSON.stringify({
    protocol: 2, platform: process.platform, arch: process.arch, node: process.version, mode,
    omitted: expected.omitted, packageManager: expected.manager, source: expected.source, sourceMetadataProjection: true,
    rootPackage: { name: expected.rootPkg.name, version: expected.rootPkg.version, integrity: expected.rootIntegrity },
    rootManifestSha256: hash(rootManifest), entrySha256, lockfilePinsRootIntegrity: true, subpaths, compiledModules, scriptAssets,
    probeSha256, metadataHelperSha256, optionalPackages: { physical: [...physical].sort(), resolution },
    nativeLoaded: loaded, binarySha256: binary ? hash(binary) : null,
    timing: {
      applicable: !missingRequired, unit: "milliseconds", kind: "first and repeated public calls in one consumer process", benchmarkGuarantee: false,
      firstCallMeaning: "first invocation of that public operation, not an isolated cold-machine benchmark",
      repeatedCallMeaning: "same consumer process; each portable call still starts and compiles a fresh PowerShell child, with no persistent warm helper",
      publicCallDurationMs: "only the public API invocation, with transparent observers enabled; excludes fixture setup and result assertions",
      durationMs: "whole scenario elapsed, including result assertions; not used for API timing comparisons",
    },
    createTimeDaclEvidence: "reviewed hash-bound implementation and bridge tests; raw consumer observation is after return",
    metadataProjection: false, warnings, rows,
  }));
} finally {
  childProcess.spawn = original.spawn;
  childProcess.spawnSync = original.spawnSync;
  fsp.open = original.open;
  syncBuiltinESMExports();
  process.removeListener("warning", onWarning);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
