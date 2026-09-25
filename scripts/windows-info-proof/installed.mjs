import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const contract = JSON.parse(fs.readFileSync(new URL('./contract.json', import.meta.url), 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.ok(contract.roles.includes(request.role));
assert.ok(contract.filesystems.includes(request.filesystem));
assert.equal(request.runtime, process.versions.bun ? 'bun' : 'node');
assert.equal(request.runtime === 'bun' ? process.versions.bun : process.version,
  request.runtime === 'bun' ? contract.bunVersion : contract.nodeVersion);
const root = fs.realpathSync.native(request.fixture);
assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
assert.deepEqual(fs.readdirSync(root), []);
const fixtureIdentity = fs.statSync(root, { bigint: true });
const require = createRequire(path.join(request.consumer, 'package.json'));
const packageJson = require.resolve('@openclaw/fs-safe/package.json');
const packageRoot = path.dirname(packageJson);
const addon = require.resolve('@openclaw/fs-safe-win32-x64-msvc');
assert.ok(fs.realpathSync.native(packageRoot).startsWith(fs.realpathSync.native(request.consumer) + path.sep));
assert.ok(fs.realpathSync.native(addon).startsWith(fs.realpathSync.native(request.consumer) + path.sep));
assert.equal(hash(addon), request.nativeSha256);
assert.equal(JSON.parse(fs.readFileSync(packageJson)).version, '0.19.0');
assert.equal(hash(request.rootManifest), request.rootManifestSha256);
const rootInput = JSON.parse(fs.readFileSync(request.rootManifest, 'utf8'));
assert.equal(rootInput.sha256, request.rootSha256);
assert.equal(rootInput.originalBaselineRootSha256, contract.originalBaselineRootSha256);
assert.equal(rootInput.wasm.sha256, contract.publishedWasm.sha256);
const canonicalPackageRoot = fs.realpathSync.native(packageRoot);
for (const [member, expected] of Object.entries(rootInput.members)) {
  assert.ok(member.startsWith('package/'));
  const selected = path.join(packageRoot, member.slice('package/'.length));
  const stat = fs.lstatSync(selected);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.ok(fs.realpathSync.native(selected).startsWith(canonicalPackageRoot + path.sep));
  assert.equal(stat.size, expected.bytes, member); assert.equal(hash(selected), expected.sha256, member);
}

const loaded = [];
const originalDlopen = process.dlopen;
process.dlopen = function (module, filename, ...args) {
  loaded.push(fs.realpathSync.native(String(filename)));
  return Reflect.apply(originalDlopen, this, [module, filename, ...args]);
};
const native = require('@openclaw/fs-safe-win32-x64-msvc');
const { configureFsSafeNative } = await import(pathToFileURL(path.join(packageRoot, 'dist/config.js')));
const { copyTree, createCloneSource, probeTreeClone } = await import(pathToFileURL(path.join(packageRoot, 'dist/copy.js')));
const { createSecretFileAtomic } = await import(pathToFileURL(path.join(packageRoot, 'dist/secret.js')));
configureFsSafeNative({ mode: 'require' });
assert.ok(loaded.includes(fs.realpathSync.native(addon)), 'actual installed addon did not load');
const required = ['fstatIdentity','observeDirectory','openBeneath','closeOwnedFd','mkdirBeneath',
  'inspectWindowsDirectory','createPrivateDirectory','protectPrivateWindowsFile','verifyPrivateWindowsFile',
  'removeOwnedTree','removeOwnedTreeSync','probeTreeClone','cloneTree'];
for (const name of required) assert.equal(typeof native[name], 'function', `${name} missing`);
const report = { role: request.role, runtime: request.runtime, filesystem: request.filesystem,
  pid: process.pid, parentPid: process.ppid, startedAt: new Date().toISOString(),
  runtimeVersion: request.runtime === 'bun' ? process.versions.bun : process.version,
  runtimeSha256: hash(process.execPath), rootPackageSha256: request.rootSha256,
  installedRootMembersVerified: Object.keys(rootInput.members).length,
  nativeSha256: hash(addon), loadedAddon: fs.realpathSync.native(addon), packageRoot,
  fixtureIdentity: { dev: String(fixtureIdentity.dev), ino: String(fixtureIdentity.ino) },
  cases: [], nativeCalls: [], fixtureHelpers: 0, fixtureObservations: [], cleanupFailures: [], timed: false };
const nodeOwned = new Set();
const nativeOwned = new Set();
const open = (file, flags = 'r') => { const fd = fs.openSync(file, flags); nodeOwned.add(fd); return fd; };
const close = fd => { assert.ok(nodeOwned.delete(fd)); fs.closeSync(fd); };
const closeNative = fd => { assert.ok(nativeOwned.delete(fd)); call('closeOwnedFd', fd); };
const same = (fd, before) => {
  const after = fs.fstatSync(fd, { bigint: true });
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
};
function call(name, ...args) {
  assert.ok(report.nativeCalls.length < contract.caps.maxNativeCallsPerLane, 'native call cap exceeded');
  report.nativeCalls.push({ case: active, name });
  return Reflect.apply(native[name], native, args);
}
function expectedError(fn, codes) {
  let error;
  try { fn(); } catch (value) { error = value; }
  assert.ok(error instanceof Error, 'expected synchronous failure');
  assert.ok(codes.includes(error.code), `${error.code}: ${error.message}`);
  return error.code;
}
async function expectedRejection(fn, code) {
  let error;
  try { await fn(); } catch (value) { error = value; }
  assert.ok(error instanceof Error, 'expected rejection');
  assert.equal(error.code, code, error.message);
  return error.code;
}
function fixture(action, target) {
  assert.ok(++report.fixtureHelpers <= contract.caps.maxOwnedFixtureHelpersPerLane);
  const child = spawnSync(request.pwsh, ['-NoProfile', '-File', request.fixtureScript,
    '-Action', action, '-Root', root, '-Path', target], {
    encoding: 'utf8', timeout: contract.caps.fixtureSeconds * 1000,
    maxBuffer: contract.caps.maxFixtureStdoutBytes, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout.trim());
  assert.equal(value.action, action); assert.equal(value.rawHandlesPassedToProduct, false);
  assert.ok(value.allocatedBytes <= contract.caps.maxSparseFileAllocatedBytes);
  report.fixtureObservations.push({ action, relativePath: path.relative(root, target).replaceAll('\\', '/'), ...value });
  return value;
}
const expectedCases = [...contract.commonCases, ...(request.filesystem === 'ReFS' ? contract.refsCases : contract.ntfsCases)];
let active;
async function run(id, action) {
  assert.equal(id, expectedCases[report.cases.length]);
  active = id;
  const observations = await action();
  inspectFixtureCaps();
  report.cases.push({ id, status: 'pass', observations });
}
function inspectFixtureCaps() {
  let entries = 0; let ordinaryBytes = 0; let sparseFiles = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      assert.ok(++entries <= contract.caps.maxFixtureEntries, 'fixture entry cap exceeded');
      const selected = path.join(directory, name); const stat = fs.lstatSync(selected);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(selected);
      else if (stat.isFile()) {
        if (stat.size > contract.caps.maxOrdinaryFixtureBytes) {
          assert.equal(request.filesystem, 'ReFS'); assert.equal(stat.size, contract.caps.sparseLogicalBytes);
          assert.ok(++sparseFiles <= 2, 'too many large sparse fixtures');
        } else ordinaryBytes += stat.size;
      } else throw new Error('Unexpected fixture kind');
    }
  }
  assert.ok(ordinaryBytes <= contract.caps.maxOrdinaryFixtureBytes, 'ordinary fixture byte cap exceeded');
}
const payload = Buffer.from('borrowed descriptor position and identity sentinel');
const regular = path.join(root, 'regular');
fs.writeFileSync(regular, payload, { flag: 'wx' });
let parentFd;
let privateFd;
let privatePath;
let privateIdentity;
let parentIdentity;
let cloneSource;
let cloneFile;
const sparseSize = contract.caps.sparseLogicalBytes;
const markerOffsets = [0, 0x80000000 - 16, sparseSize - 16];
const marker = (filename, offset) => {
  const fd = open(filename); const data = Buffer.alloc(16);
  try { assert.equal(fs.readSync(fd, data, 0, 16, offset), 16); return data; } finally { close(fd); }
};
try {
  await run('borrowed-file', () => {
    const fd = open(regular); const before = fs.fstatSync(fd, { bigint: true });
    const first = Buffer.alloc(3); assert.equal(fs.readSync(fd, first, 0, 3, null), 3);
    const observed = call('fstatIdentity', fd);
    assert.equal(observed.isFile, true); assert.equal(observed.size, payload.length);
    const next = Buffer.alloc(3); assert.equal(fs.readSync(fd, next, 0, 3, null), 3);
    assert.deepEqual(first, payload.subarray(0, 3)); assert.deepEqual(next, payload.subarray(3, 6));
    same(fd, before); close(fd);
    return { size: observed.size, borrowedDescriptorAndPositionPreserved: true };
  });
  await run('borrowed-directory', () => {
    parentFd = open(root); const before = fs.fstatSync(parentFd, { bigint: true });
    assert.equal(call('fstatIdentity', parentFd).isDirectory, true);
    const observed = call('observeDirectory', root);
    assert.equal(observed.dev, before.dev); assert.equal(observed.ino, before.ino);
    assert.equal(fs.realpathSync.native(observed.realPath), root);
    call('mkdirBeneath', parentFd, 'borrowed-created', 0o700);
    assert.equal(fs.statSync(path.join(root, 'borrowed-created')).isDirectory(), true);
    same(parentFd, before);
    return { observedExactIdentity: true, borrowedParentPreserved: true };
  });
  await run('native-open-close', () => {
    const before = fs.fstatSync(parentFd, { bigint: true });
    const opened = call('openBeneath', parentFd, 'regular', fs.constants.O_RDONLY);
    nativeOwned.add(opened.fd);
    assert.equal(call('fstatIdentity', opened.fd).size, payload.length);
    const data = Buffer.alloc(payload.length);
    assert.equal(fs.readSync(opened.fd, data, 0, data.length, 0), data.length);
    assert.deepEqual(data, payload); closeNative(opened.fd);
    same(parentFd, before);
    return { nativeOwnedCloseAndHostReads: true, borrowedParentPreserved: true };
  });
  await run('missing-and-reparse', () => {
    const missing = expectedError(() => call('openBeneath', parentFd, 'missing', fs.constants.O_RDONLY), ['ENOENT']);
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'outside sentinel', { flag: 'wx' });
    fs.symlinkSync(outside, path.join(root, 'junction'), 'junction');
    const reparse = expectedError(() => call('openBeneath', parentFd, 'junction/keep', fs.constants.O_RDONLY), ['EIO', 'ELOOP']);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside sentinel');
    return { missing, reparse, outsidePreserved: true };
  });
  await run('private-protect-verify', async () => {
    const directory = path.join(root, 'private'); call('createPrivateDirectory', directory);
    parentIdentity = call('inspectWindowsDirectory', directory, true).identity;
    assert.match(parentIdentity, /^[0-9a-f]{16}:[0-9a-f]{32}$/);
    privatePath = path.join(directory, 'secret'); privateFd = open(privatePath, 'wx+');
    fs.writeSync(privateFd, payload);
    const before = fs.fstatSync(privateFd, { bigint: true });
    privateIdentity = call('protectPrivateWindowsFile', privateFd, privatePath, parentIdentity).identity;
    assert.match(privateIdentity, /^[0-9a-f]{16}:[0-9a-f]{32}$/);
    call('verifyPrivateWindowsFile', privateFd, privatePath, privateIdentity, parentIdentity, 1);
    same(privateFd, before); assert.deepEqual(fs.readFileSync(privatePath), payload);
    const publicSecret = path.join(directory, 'public-secret');
    await createSecretFileAtomic({ rootDir: directory, filePath: publicSecret, content: 'installed secret witness', mode: 0o600 });
    assert.equal(fs.readFileSync(publicSecret, 'utf8'), 'installed secret witness');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['public-secret', 'secret']);
    return { fullIdentityAndPrivateAdmission: true, borrowedFilePreserved: true, publicSecretCreatedAndRead: true };
  });
  await run('private-identity-and-links', () => {
    const wrongParent = parentIdentity === '0000000000000000:00000000000000000000000000000000'
      ? '0000000000000001:00000000000000000000000000000000' : '0000000000000000:00000000000000000000000000000000';
    const parent = expectedError(() => call('verifyPrivateWindowsFile', privateFd, privatePath, privateIdentity, wrongParent, 1), ['EIO']);
    const alias = privatePath + '-alias'; fs.linkSync(privatePath, alias);
    const links = expectedError(() => call('verifyPrivateWindowsFile', privateFd, privatePath, privateIdentity, parentIdentity, 1), ['EIO']);
    assert.deepEqual(fs.readFileSync(privatePath), payload); assert.deepEqual(fs.readFileSync(alias), payload);
    fs.unlinkSync(alias); close(privateFd); privateFd = undefined;
    return { parent, links, bothAliasesPreservedBeforeFixtureCleanup: true };
  });
  for (const mode of ['async', 'sync']) await run(`owned-remove-${mode}`, async () => {
    const name = `owned-${mode}`; const directory = path.join(root, name);
    fs.mkdirSync(path.join(directory, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'nested/value'), 'owned', { flag: 'wx' });
    fs.symlinkSync(path.join(root, 'outside'), path.join(directory, 'nested/junction'), 'junction');
    const fd = open(directory); const before = fs.fstatSync(parentFd, { bigint: true });
    const result = mode === 'async' ? await call('removeOwnedTree', parentFd, name, fd)
      : call('removeOwnedTreeSync', parentFd, name, fd);
    assert.equal(result.outcome, 'removed'); close(fd);
    assert.equal(fs.existsSync(directory), false); same(parentFd, before);
    assert.equal(fs.readFileSync(path.join(root, 'outside/keep'), 'utf8'), 'outside sentinel');
    return { outcome: result.outcome, outsidePreserved: true, borrowedDescriptorsCloseNormally: true };
  });
  await run('owned-replaced-root', async () => {
    const directory = path.join(root, 'replaced'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'owned'), 'original', { flag: 'wx' });
    const fd = open(directory); const before = fs.fstatSync(fd, { bigint: true });
    fs.renameSync(directory, directory + '-original'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'keep'), 'replacement', { flag: 'wx' });
    const result = await call('removeOwnedTree', parentFd, 'replaced', fd);
    assert.equal(result.outcome, 'preserved'); same(fd, before); close(fd);
    assert.equal(fs.readFileSync(path.join(directory, 'keep'), 'utf8'), 'replacement');
    assert.equal(fs.readFileSync(directory + '-original/owned', 'utf8'), 'original');
    return { outcome: result.outcome, bothNamesPreserved: true };
  });
  await run('invalid-descriptors', () => {
    const negative = expectedError(() => call('fstatIdentity', -1), ['EBADF']);
    const fd = open(regular); close(fd);
    const closed = expectedError(() => call('fstatIdentity', fd), ['EBADF']);
    assert.deepEqual(fs.readFileSync(regular), payload);
    return { negative, closed, proofBoundary: 'entry admission, not raw syscall error capture' };
  });
  if (request.filesystem === 'NTFS') await run('ntfs-clone-unsupported', async () => {
    assert.equal(call('probeTreeClone', parentFd), null);
    const source = path.join(root, 'clone-source'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'keep'), 'no byte-copy fallback', { flag: 'wx' });
    const destination = path.join(root, 'clone-destination');
    const code = await expectedRejection(() => copyTree(source, destination, { clone: 'always' }), 'unsupported-platform');
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readFileSync(path.join(source, 'keep'), 'utf8'), 'no byte-copy fallback');
    return { code, sourcePreserved: true, noDestination: true };
  });
  else {
    await run('refs-sparse-clone', async () => {
      assert.equal(call('probeTreeClone', parentFd), 'refs'); assert.equal(probeTreeClone(root), 'refs');
      cloneSource = path.join(root, 'clone-source'); await createCloneSource(cloneSource);
      const empty = path.join(root, 'clone-empty'); await copyTree(cloneSource, empty, { clone: 'always', concurrency: 1 });
      assert.deepEqual(fs.readdirSync(empty), []);
      fs.mkdirSync(path.join(cloneSource, 'nested/empty'), { recursive: true });
      cloneFile = path.join(cloneSource, 'large'); const fd = open(cloneFile, 'wx+'); close(fd);
      fixture('sparse', cloneFile);
      const writer = open(cloneFile, 'r+'); fs.ftruncateSync(writer, sparseSize);
      for (const [index, offset] of markerOffsets.entries()) fs.writeSync(writer, Buffer.alloc(16, 17 + index), 0, 16, offset);
      close(writer);
      for (const rel of ['large', 'nested/empty', 'nested', '']) fs.utimesSync(path.join(cloneSource, rel), 1600000000, 1600000000);
      const destination = path.join(root, 'clone-copy'); await copyTree(cloneSource, destination, { clone: 'always', concurrency: 1 });
      const copied = path.join(destination, 'large'); assert.equal(fs.statSync(copied).size, sparseSize);
      for (const rel of ['large', 'nested/empty', 'nested', '']) assert.equal(fs.statSync(path.join(destination, rel)).mtimeMs, fs.statSync(path.join(cloneSource, rel)).mtimeMs);
      const markers = markerOffsets.map(offset => {
        const source = marker(cloneFile, offset); const target = marker(copied, offset);
        assert.deepEqual(target, source); return { offset, source: source.toString('hex'), target: target.toString('hex') };
      });
      const originalExtent = fixture('extent', cloneFile); const copiedExtent = fixture('extent', copied);
      assert.equal(copiedExtent.lcn, originalExtent.lcn);
      assert.ok(copiedExtent.allocatedBytes + originalExtent.allocatedBytes <= contract.caps.maxFixtureAllocatedBytes);
      const changed = open(copied, 'r+'); fs.writeSync(changed, Buffer.alloc(16, 99), 0, 16, sparseSize - 16); close(changed);
      assert.deepEqual(marker(cloneFile, sparseSize - 16), Buffer.alloc(16, 19));
      assert.deepEqual(marker(copied, sparseSize - 16), Buffer.alloc(16, 99));
      return { backend: 'refs', size: sparseSize, markers, metadataPreserved: true, sharedExtent: true,
        sourceTailAfterMutation: marker(cloneFile, sparseSize - 16).toString('hex'),
        cloneTailAfterMutation: marker(copied, sparseSize - 16).toString('hex'), copyOnWriteIndependent: true };
    });
    await run('refs-live-writer-conflict', async () => {
      const fd = open(cloneFile, 'r+'); const before = fs.fstatSync(fd, { bigint: true });
      const destination = path.join(root, 'clone-writer-conflict');
      const code = await expectedRejection(() => copyTree(cloneSource, destination, { clone: 'always', concurrency: 1 }), 'EBUSY');
      same(fd, before); close(fd); assert.equal(fs.existsSync(destination), false);
      assert.deepEqual(marker(cloneFile, sparseSize - 16), Buffer.alloc(16, 19));
      return { code, borrowedWriterPreserved: true, sourcePreserved: true, noDestination: true };
    });
    await run('refs-named-stream-rejection', async () => {
      const ads = cloneFile + ':metadata'; fs.writeFileSync(ads, 'retained named stream', { flag: 'wx' });
      const destination = path.join(root, 'clone-ads');
      const code = await expectedRejection(() => copyTree(cloneSource, destination, { clone: 'always', concurrency: 1 }), 'ENOTSUP');
      assert.equal(fs.existsSync(destination), false); assert.equal(fs.readFileSync(ads, 'utf8'), 'retained named stream');
      assert.deepEqual(marker(cloneFile, sparseSize - 16), Buffer.alloc(16, 19));
      return { code, namedStreamAndSourcePreserved: true, noDestination: true };
    });
  }
  assert.deepEqual(report.cases.map(row => row.id), expectedCases);
  assert.ok(report.cases.length <= contract.caps.maxCasesPerLane);
  report.ok = true;
} catch (error) {
  report.ok = false; report.failedCase = active;
  report.error = { name: error?.name, code: error?.code, message: String(error?.message ?? error).replaceAll(root, '<fixture>') };
} finally {
  for (const fd of [...nativeOwned]) try { closeNative(fd); } catch (error) { report.cleanupFailures.push(String(error)); }
  for (const fd of [...nodeOwned]) try { close(fd); } catch (error) { report.cleanupFailures.push(String(error)); }
  try {
    const after = fs.statSync(root, { bigint: true });
    assert.equal(after.dev, fixtureIdentity.dev); assert.equal(after.ino, fixtureIdentity.ino);
  } catch (error) { report.cleanupFailures.push(String(error)); }
  report.borrowedAndNativeDescriptorsSettled = nodeOwned.size === 0 && nativeOwned.size === 0;
  if (report.cleanupFailures.length) report.ok = false;
  fs.writeFileSync(request.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
if (!report.ok) process.exitCode = 1;
