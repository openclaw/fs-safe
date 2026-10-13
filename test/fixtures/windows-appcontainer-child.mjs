import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const operation = workerData?.operation ?? process.argv[2];
const mode = workerData?.mode ?? process.argv[3];
const thread = isMainThread ? 'main' : 'worker';
const mark = phase => fs.appendFileSync(path.join(here, `progress-${operation}-${mode}-${thread}.jsonl`), JSON.stringify({ phase, time: new Date().toISOString() }) + '\n');
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
mark('imports:after');

async function prove(thread) {
  const ordinary = operation === 'ordinary';
  const dir = path.join(here, `${ordinary ? 'ordinary-' : ''}${mode}-${thread}`), file = path.join(dir, 'file');
  if (operation === 'unsupported') {
    const unavailable = error => error instanceof FsSafeError && error.code === 'helper-unavailable';
    assert.throws(() => realpathSync.native(here), unavailable);
    assert.throws(() => createDirectorySync(dir, { private: true }), unavailable);
    assert.throws(() => createFileSync(path.join(here, `unsupported-${thread}`), { private: true }), unavailable);
    await assert.rejects(inspectWindowsAcl(path.join(here, 'require-main')), unavailable);
    await assert.rejects(inspectPathPermissions(path.join(here, 'require-main')), unavailable);
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
  const canonicalPaths = aclEntries.map(value => ({ ...value, canonical: realpathSync.native(value.path) }));
  if (!ordinary) {
    const expected = JSON.parse(fs.readFileSync(path.join(here, 'canonical-expected.json'), 'utf8'));
    const variants = fs.readFileSync(path.join(here, 'canonicalization-paths.txt'), 'utf8').trim().split(/\r?\n/)
      .map(line => line.split('\t')).filter(([label]) => label.startsWith('shared'));
    for (const [, value] of variants) assert.equal(realpathSync.native(value), expected);
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
