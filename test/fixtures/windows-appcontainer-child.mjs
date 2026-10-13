import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const operation = workerData?.operation ?? process.argv[2];
const mode = workerData?.mode ?? process.argv[3];
const thread = isMainThread ? 'main' : 'worker';
const mark = phase => fs.appendFileSync(path.join(here, `progress-${operation}-${mode}-${thread}.jsonl`), JSON.stringify({ phase, time: new Date().toISOString() }) + '\n');
if (operation !== 'ordinary') {
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[method] = () => { throw new Error(`Forbidden child process: ${method}`); };
  }
  syncBuiltinESMExports();
}
mark('imports:before');
process.env.FS_SAFE_NATIVE_MODE = mode;
const { createDirectorySync, createFileSync, inspectWindowsAcl } = await import('./pkg/dist/advanced.js');
const { readOwnerAndDacl } = await import('./pkg/dist/permissions-public.js');
const { readSecureFile } = await import('./pkg/dist/secure-file.js');
const { tempWorkspaceSync } = await import('./pkg/dist/temp.js');
const { inspectPathPermissions } = await import('./pkg/dist/permissions-public.js');
const principals = JSON.parse(fs.readFileSync(path.join(here, 'profiles.json'), 'utf8'));
const { realpathSync } = await import('./pkg/dist/realpath.js');
const { FsSafeError } = await import('./pkg/dist/errors.js');
const commands = await import('./pkg/dist/windows-security-command.js');
const { readOwnerAndDaclBatch } = await import('./pkg/dist/permissions-public.js');
const { executePermissionCommand } = await import('./pkg/dist/permission-exec.js');
const { getNativeBinding } = await import('./pkg/dist/native.js');
mark('imports:after');

async function prove(thread) {
  const ordinary = operation === 'ordinary';
  if (mode === 'require') assert.equal(getNativeBinding().isWindowsAppContainer(), !ordinary);
  const dir = path.join(here, `${ordinary ? 'ordinary-' : ''}${mode}-${thread}`), file = path.join(dir, 'file');
  if (operation === 'native-off') {
    assert.equal(getNativeBinding(), undefined);
    const native = fs.realpathSync.native;
    let original;
    fs.realpathSync.native = (...args) => {
      try { return native(...args); } catch (error) { original = error; throw error; }
    };
    const started = performance.now();
    try {
      assert.throws(() => realpathSync.native(here), error =>
        error === original && error.code === 'EPERM' && error.errno === -4048 && error.syscall === 'realpath');
    } finally { fs.realpathSync.native = native; }
    assert(performance.now() - started < 1_000, 'native-off realpath must fail promptly');
    return [];
  }
  if (operation === 'deny') {
    for (const read of [() => fs.readdirSync(dir), () => fs.readFileSync(file), () => fs.writeFileSync(file, 'attack'), () => readOwnerAndDacl(dir)]) {
      assert.throws(read, e => ['EACCES', 'EPERM', 'permission-unverified', 'insecure-permissions'].includes(e.code), 'different container must be denied');
    }
    return [];
  }
  if (operation === 'create' || ordinary) {
    mark('canonical-root:before');
    realpathSync.native(here);
    mark('canonical-root:after');
    mark('create-directory:before');
    createDirectorySync(dir, { private: true });
    mark('create-directory:after');
    const owned = createFileSync(file, { private: true });
    mark('create-file:after');
    try { fs.writeSync(owned.fd, 'private'); } finally { owned.close(); }
    const workspace = tempWorkspaceSync({ rootDir: dir, prefix: 'workspace' });
    mark('workspace:created');
    workspace.writeText('payload', 'workspace');
    assert.equal(workspace.read('payload').toString(), 'workspace');
    workspace.cleanup();
    mark('workspace:cleaned');
  }
  if (!ordinary) {
    const unavailable = error => error instanceof FsSafeError && error.code === 'helper-unavailable';
    assert.throws(() => commands.readWindowsSecurityFactsCommand(dir), unavailable);
    assert.throws(() => commands.createPrivateWindowsDirectoryCommandSync(path.join(dir, 'refused')), unavailable);
    assert.throws(() => commands.inspectWindowsDirectoryCommandSync(dir, true), unavailable);
    await assert.rejects(commands.createPrivateWindowsDirectoryCommand(path.join(dir, 'refused')), unavailable);
    await assert.rejects(commands.inspectWindowsDirectoryCommand(dir, true), unavailable);
    const fd = fs.openSync(file, 'r+');
    const identity = '0'.repeat(16) + ':' + '0'.repeat(32);
    try {
      await assert.rejects(commands.inspectWindowsDescriptorCommand(fd), unavailable);
      assert.throws(() => commands.protectPrivateWindowsFileCommandSync(fd, file, identity), unavailable);
      assert.throws(() => commands.verifyPrivateWindowsFileCommandSync(fd, file, identity, identity), unavailable);
      await assert.rejects(commands.protectPrivateWindowsFileCommand(fd, file, identity), unavailable);
      await assert.rejects(commands.verifyPrivateWindowsFileCommand(fd, file, identity, identity), unavailable);
    } finally { fs.closeSync(fd); }
    await assert.rejects(readOwnerAndDaclBatch([dir]), unavailable);
    await assert.rejects(executePermissionCommand('windows-security-helper.exe', ['owner', dir]), unavailable);
  }
  assert.deepEqual(fs.readdirSync(dir), ['file']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'private');
  const secure = await readSecureFile({ filePath: file });
  mark('secure-read:after');
  assert.equal(secure.buffer.toString(), 'private');
  assert.equal(secure.permissions.ownerTrusted, true);
  const aclEntries = [];
  for (const target of [dir, file]) {
    const facts = readOwnerAndDacl(target);
    mark('owner-query:after');
    assert.equal(facts.status, 'supported');
    assert.equal(facts.aces.length, ordinary ? 3 : 4);
    assert.deepEqual(new Set(facts.aces.map(x => x.sid)), new Set([facts.currentUserSid, 's-1-5-18', 's-1-5-32-544', ...(ordinary ? [] : [principals[0]])]));
    assert(facts.aces.every(x => x.mask === 0x1f01ff && x.aceType === 'allow'));
    assert(facts.aces.every(x => x.flags.objectInherit === (target === dir) && x.flags.containerInherit === (target === dir)));
    const acl = await inspectWindowsAcl(target);
    mark('acl-inspection:after');
    assert.equal(acl.ok, true, JSON.stringify(acl));
    assert.equal(acl.untrustedGroup.length, 0);
    assert.equal(acl.untrustedWorld.length, 0);
    aclEntries.push({ path: target, entries: acl.entries });
  }
  const permissions = await inspectPathPermissions(dir);
  mark('permissions-inspection:after');
  assert.equal(permissions.groupReadable, false, JSON.stringify(permissions));
  assert.equal(permissions.groupWritable, false, JSON.stringify(permissions));
  if (!ordinary) {
    const foreignPath = path.join(here, 'foreign-owned');
    const facts = readOwnerAndDacl(foreignPath);
    assert.equal(facts.ownerSid, 's-1-5-32-544');
    assert.notEqual(facts.ownerSid, facts.currentUserSid);
    const nativePermissions = await inspectPathPermissions(foreignPath);
    assert.equal(nativePermissions.groupReadable, false);
    assert.equal(nativePermissions.groupWritable, false);
    const nativeAcl = await inspectWindowsAcl(foreignPath);
    const stdout = fs.readFileSync(path.join(here, 'foreign-owner-command.json'), 'utf8');
    const commandAcl = await inspectWindowsAcl(foreignPath, { exec: async () => ({ stdout, stderr: '' }) });
    assert.deepEqual(commandAcl, nativeAcl);
    assert.equal(commandAcl.untrustedGroup.length, 0);
    aclEntries.push({ path: foreignPath, entries: nativeAcl.entries });
    mark('foreign-owner-parity:after');
  }
  const canonicalPaths = aclEntries.map(value => ({ ...value, canonical: realpathSync.native(value.path) }));
  if (!ordinary) {
    const expected = JSON.parse(fs.readFileSync(path.join(here, 'canonical-expected.json'), 'utf8'));
    const variants = fs.readFileSync(path.join(here, 'canonicalization-paths.txt'), 'utf8').trim().split(/\r?\n/)
      .map(line => line.split('\t')).filter(([label]) => label.startsWith('shared'));
    for (const [, value] of variants) assert.equal(realpathSync.native(value), expected);
    const relative = path.relative(process.cwd(), file);
    const canonical = realpathSync.native(relative);
    assert.equal(canonical, realpathSync.native(file));
    await assert.rejects(readSecureFile({ filePath: relative }), error =>
      error instanceof FsSafeError && error.code === 'invalid-path');
    canonicalPaths.push({ ...aclEntries[1], input: relative, canonical });
    assert.equal(realpathSync.native('.'), expected);
    mark('relative-path:after');
  }
  mark('proof:complete');
  return canonicalPaths;
}
if (isMainThread) {
  try {
    const canonicalPaths = await prove('main');
    mark('worker:before');
    const workerPaths = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { operation, mode } });
      let paths;
      worker.once('message', value => { paths = value; });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 && paths ? resolve(paths) : reject(new Error(`Worker exit ${code}`)));
    });
    mark('worker:exited');
    fs.writeFileSync(path.join(here, `${operation}-${mode}.json`), JSON.stringify({ operation, mode, arch: process.arch, threads: ['main', 'worker'], canonicalPaths: [...canonicalPaths, ...workerPaths], ok: true }));
  } catch (error) {
    fs.writeFileSync(path.join(here, `${operation}-${mode}.json`), JSON.stringify({ error: error.stack, code: error.code }));
    process.exitCode = 1;
  }
} else { parentPort.postMessage(await prove('worker')); }
