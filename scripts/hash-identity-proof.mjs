// Controlled pathname identity proof against the selected build, never a hash implementation.
// Usage: node scripts/hash-identity-proof.mjs --repo BUILT_REPO --output NEW_DIR
//   --variant baseline|patched [--source-ref COMMIT] [--require-windows] [--include-unscoped]
// Companion stats are additional, non-atomic observations. Keep local smoke receipts private.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  repo: { type: 'string' }, output: { type: 'string' }, variant: { type: 'string' },
  'compiled-sha256': { type: 'string' }, 'source-ref': { type: 'string' },
  companions: { type: 'string', default: 'after' },
  'include-unscoped': { type: 'boolean', default: false },
  'require-windows': { type: 'boolean', default: false },
  'timeout-ms': { type: 'string', default: '20000' },
} });
if (!values.repo || !values.output || !['baseline', 'patched'].includes(values.variant)) {
  throw new Error('Required: --repo BUILT_COPY --output NEW_DIRECTORY --variant baseline|patched');
}
const repo = realpathSync(values.repo);
const output = path.resolve(values.output);
// Creating an exclusive directory prevents receipts/fixtures from earlier runs being overwritten.
mkdirSync(output);
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? `${item}n` : item, 2) + '\n';
const write = (name, value) => writeFileSync(path.join(output, name), json(value), { flag: 'wx', mode: 0o600 });
const actualCreateHash = crypto.createHash;
const digest = value => actualCreateHash('sha256').update(value).digest('hex');
const errorInfo = error => ({ name: error?.name, code: error?.code, message: error?.message ?? String(error) });
const runtime = {
  node: process.version, versions: { ...process.versions }, platform: process.platform, arch: process.arch,
  pid: process.pid, executableSha256: digest(readFileSync(process.execPath)),
  rawV8CoverageEnabled: Boolean(process.env.NODE_V8_COVERAGE),
  platformOverride: false, osAndFilesystem: 'Collected separately by the PowerShell driver.',
};
const summary = {
  schema: 1, startedAt: new Date().toISOString(), runtime,
  variant: values.variant, sourceRefLabel: values['source-ref'] ?? null,
  sourceRefLabelIsNotGitVerification: true, baselineCommit: 'f8876aab64bca29d2a4f742c816ddd33ea8555cb',
  options: values, cases: [],
  importedHashModuleUrl: pathToFileURL(path.join(repo, 'dist/file-hash.js')).href,
  interpretation: [
    'A baseline admission is an observation, never a security pass.',
    'Known distinct retained bigint identities are required; unknown host identities make this proof incomplete.',
    'Real host scenarios do not emulate unknown identities; the focused model tests cover bounded retry semantics.',
    'No historical-event attribution. All swaps are controlled test injections.',
    'All stat values are actual host results, with no platform or stat adapters.',
    'Companion stats and retained-file evidence are separate syscalls, never atomic pairs.',
    'Native mode is off; a test-loader tripwire counts unexpected native activity. This is not native binding proof.',
    'Raw NODE_V8_COVERAGE is runtime instrumentation, not Vitest coverage or a threshold gate.',
  ],
};
const actual = Object.fromEntries(['open', 'lstat', 'readFile', 'writeFile', 'rename'].map(k => [k, fs[k].bind(fs)]));
let activeCase;
let timer;
let fingerprintBefore;
const fingerprintFiles = [
  'package.json', 'pnpm-lock.yaml', 'vitest.config.ts', 'src/file-hash.ts',
  'src/file-identity.ts', 'src/strict-file-identity.ts', 'test/file-hash.test.ts',
];
async function fingerprint() {
  const dist = (await fs.readdir(path.join(repo, 'dist'))).filter(n => n.endsWith('.js')).sort();
  const patchTests = values.variant === 'patched' ? ['test/file-hash-identity.test.ts', 'test/helpers/file-hash-identity.ts'] : [];
  const files = [...fingerprintFiles, ...patchTests, ...dist.map(n => `dist/${n}`)];
  return Object.fromEntries(files.map(name => [name, digest(readFileSync(path.join(repo, name)))]));
}
function atom(value) {
  return { type: typeof value, value: typeof value === 'undefined' ? null : value,
    numberIsSafeInteger: typeof value === 'number' ? Number.isSafeInteger(value) : null };
}
function stats(stat) {
  const fields = {};
  for (const name of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks',
    'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) {
    if (name in stat) fields[name] = atom(stat[name]);
  }
  return { fields, regular: stat.isFile(), symlink: stat.isSymbolicLink(), directory: stat.isDirectory() };
}
function identity(stat) { return { dev: stat.dev, ino: stat.ino }; }
function known(id) { return typeof id.dev === 'bigint' && typeof id.ino === 'bigint' &&
  (process.platform !== 'win32' || (id.dev !== 0n && id.ino !== 0n)); }
function equalId(a, b) { return a.dev === b.dev && a.ino === b.ino; }

try {
  assert(['after', 'none'].includes(values.companions), 'invalid companions option');
  const timeout = Number(values['timeout-ms']);
  assert(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 60000, 'timeout range is 1000..60000ms');
  if (values['require-windows']) {
    assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
    assert([22, 24].includes(Number(process.versions.node.split('.')[0])), 'Windows proof needs Node 22 or 24');
  }
  fingerprintBefore = await fingerprint();
  summary.fingerprintBefore = fingerprintBefore;
  summary.harnessSha256 = digest(readFileSync(fileURLToPath(import.meta.url)));
  if (values['compiled-sha256']) assert.equal(fingerprintBefore['dist/file-hash.js'], values['compiled-sha256']);
  if (values.variant === 'baseline') {
    assert.equal(fingerprintBefore['src/file-hash.ts'],
      '11d6640fe917831e2c49b0778e770bb6309201662c1ffe5b2127ef3e281c9b4f',
      'baseline must preserve the source from the documented baseline commit');
  }
  const vitestPackage = realpathSync(path.join(repo, 'node_modules/vitest/package.json'));
  const require = createRequire(vitestPackage);
  const spyModule = require.resolve('@vitest/spy');
  const { spyOn } = await import(pathToFileURL(spyModule).href);
  summary.spy = { implementation: '@vitest/spy', vitestVersion: JSON.parse(readFileSync(vitestPackage)).version,
    moduleSha256: digest(readFileSync(spyModule)) };
  const { sha256File } = await import(pathToFileURL(path.join(repo, 'dist/file-hash.js')).href);
  const { configureFsSafeNative, __resetFsSafeNativeConfigForTest } =
    await import(pathToFileURL(path.join(repo, 'dist/native-config.js')).href);
  const { __setNativeLoaderForTest, __resetNativeLoaderForTest } =
    await import(pathToFileURL(path.join(repo, 'dist/native.js')).href);
  write('preflight.json', summary);

  async function scenario(name, kind) {
    const dir = path.join(output, name);
    mkdirSync(dir);
    const target = path.join(dir, 'payload.bin');
    const displaced = path.join(dir, 'payload.displaced');
    const unrelated = path.join(dir, 'unrelated.bin');
    const receipt = {
      schema: 1, name, kind, runtime, expectedImplementation: values.variant,
      compiledSha256: fingerprintBefore['dist/file-hash.js'],
      spy: summary.spy, companions: values.companions,
      labels: { statSource: 'real host kernel observations; no synthetic adapter',
        injection: kind === 'unscoped' ? 'CONTROLLED unscoped one-shot hazard injection before preview; NOT coverage-caused' :
          kind === 'replacement' ? 'CONTROLLED target-scoped replacement after preview' : 'stable real fixture control' },
      fixture: { target, displaced, unrelated }, events: [], invariants: [],
      counts: { hashCalls: 0, jsHashCreates: 0, targetOpens: 0, unrelatedOpens: 0, otherOpens: 0, algorithmLstats: 0,
        descriptorStats: 0, companionStats: 0, reads: 0, bytesRead: 0, closes: 0, closed: 0,
        unrelatedCloses: 0, nativeLoaderCalls: 0, nativeCalls: 0, rescueCloses: 0, swaps: 0 },
    };
    activeCase = receipt;
    let armed = kind !== 'stable';
    let swapped = false;
    let targetOpenEntered = false;
    let previewReturned = 0;
    let hashStarted = false;
    let openSpy, lstatSpy, hashSpy;
    const handles = [];
    const event = (type, data = {}) => {
      assert(receipt.events.length < 150, 'event bound exceeded');
      const entry = { order: receipt.events.length + 1, monotonicNs: process.hrtime.bigint(), type,
        armed, swapped, hashStarted, ...data };
      receipt.events.push(entry); return entry;
    };
    function check(name, condition) {
      receipt.invariants.push({ name, passed: Boolean(condition) });
    }
    const classify = candidate => {
      const candidatePath = candidate instanceof URL ? fileURLToPath(candidate) :
        Buffer.isBuffer(candidate) ? candidate.toString('utf8') : candidate;
      if (typeof candidatePath !== 'string') return 'other';
      return candidatePath === target ? 'target' : candidatePath === unrelated ? 'unrelated' : 'other';
    };
    const argsRecord = args => args.map(arg => arg instanceof URL ? { type: 'URL', value: arg.href } :
      Buffer.isBuffer(arg) ? { type: 'Buffer', utf8: arg.toString('utf8'), hex: arg.toString('hex') } : atom(arg));
    async function retained(label, file) {
      const stat = await actual.lstat(file, { bigint: true });
      const content = await actual.readFile(file);
      const record = { label, separateObservation: true, stat: stats(stat), identity: identity(stat),
        contentUtf8: content.toString('utf8'), bytes: content.length, sha256: digest(content) };
      event('additional-retained-evidence', record);
      return record;
    }
    async function companion(method, stage, call, originalOptions, originalEvent) {
      if (values.companions !== 'after') return;
      const options = { bigint: !originalOptions?.bigint };
      receipt.counts.companionStats++;
      const start = event('additional-stat-enter', { method, stage, options: atom(options), afterOriginalEvent: originalEvent });
      try {
        const stat = await call(options);
        event('additional-stat-return', { entered: start.order, method, stage, result: stats(stat),
          separateSyscall: true, atomicWithOriginal: false });
      } catch (error) {
        event('additional-stat-error', { entered: start.order, error: errorInfo(error) });
        throw error;
      }
    }
    async function swap(candidate) {
      assert(armed && !swapped, 'swap must be one-shot');
      if (kind === 'replacement') {
        assert.equal(classify(candidate), 'target');
        assert(previewReturned > 0, 'target swap must follow original algorithm preview receipt');
      }
      armed = false;
      event('swap-begin', { trigger: classify(candidate), previewReturned });
      await actual.rename(target, displaced);
      await actual.writeFile(target, 'replacement', { flag: 'wx' });
      swapped = true;
      receipt.counts.swaps++;
      event('swap-complete', { trigger: classify(candidate), previewReturned });
    }
    async function trackOpen(args, doSwap) {
      const classification = classify(args[0]);
      const entry = event('open-spy-enter', { classification,
        arguments: classification === 'other' ? '[unexpected non-fixture arguments withheld]' : argsRecord(args),
        previewReturned });
      if (classification === 'other') {
        receipt.counts.otherOpens++;
        throw new Error('Unexpected non-fixture fs.open: refusing interference and withholding unrelated path');
      }
      if (classification === 'target') {
        targetOpenEntered = true;
        assert(++receipt.counts.targetOpens <= 1, 'hash must not reopen target');
      } else assert(++receipt.counts.unrelatedOpens <= 1, 'unexpected unrelated open');
      if (doSwap) await swap(args[0]);
      const handle = await actual.open(...args);
      event('open-spy-return', { entered: entry.order, classification, fd: handle.fd });
      const raw = { stat: handle.stat.bind(handle), read: handle.read.bind(handle), close: handle.close.bind(handle) };
      const tracked = { handle, raw, classification, closed: false };
      handles.push(tracked);
      if (classification === 'target') {
        handle.stat = async (...statArgs) => {
          assert(++receipt.counts.descriptorStats <= 4, 'descriptor stat bound');
          const start = event('algorithm-stat-enter', { method: 'FileHandle.stat', stage: 'descriptor',
            descriptorOrdinal: receipt.counts.descriptorStats, arguments: argsRecord(statArgs) });
          const stat = await raw.stat(...statArgs);
          const end = event('algorithm-stat-return', { entered: start.order, method: 'FileHandle.stat',
            stage: 'descriptor', result: stats(stat) });
          await companion('FileHandle.stat', 'descriptor', raw.stat, statArgs[0], end.order);
          return stat;
        };
        handle.read = async (...readArgs) => {
          assert(++receipt.counts.reads <= 4, 'bounded tiny-fixture read count');
          const start = event('algorithm-read-enter', { arguments: readArgs.map(arg =>
            Buffer.isBuffer(arg) ? { type: 'Buffer', byteLength: arg.length, contents: 'not captured: allocation may be uninitialized' } : atom(arg)) });
          const result = await raw.read(...readArgs);
          receipt.counts.bytesRead += result.bytesRead;
          event('algorithm-read-return', { entered: start.order, bytesRead: result.bytesRead });
          return result;
        };
      }
      handle.close = async (...closeArgs) => {
        if (classification === 'target') receipt.counts.closes++;
        else receipt.counts.unrelatedCloses++;
        const start = event('close-enter', { classification, arguments: argsRecord(closeArgs) });
        await raw.close(...closeArgs);
        tracked.closed = true;
        if (classification === 'target') receipt.counts.closed++;
        event('close-return', { entered: start.order, classification });
      };
      return handle;
    }
    timer = setTimeout(() => {
      receipt.timeout = { milliseconds: timeout, failClosed: true };
      write(`${name}.timeout.json`, receipt);
      summary.timeoutCase = name; write('summary.timeout.json', summary);
      process.exit(124);
    }, timeout);
    try {
      await actual.writeFile(target, 'original', { flag: 'wx' });
      await actual.writeFile(unrelated, 'auxiliary', { flag: 'wx' });
      receipt.beforeAdditional = await retained('initial-original: outside algorithm', target);
      configureFsSafeNative({ mode: 'off' });
      __setNativeLoaderForTest(() => {
        receipt.counts.nativeLoaderCalls++;
        return { sha256File() {
          receipt.counts.nativeCalls++; event('unexpected-native-call');
          throw new Error('Native activity is forbidden in this mode-off diagnostic');
        } };
      });
      hashSpy = spyOn(crypto, 'createHash').mockImplementation((...args) => {
        receipt.counts.jsHashCreates++;
        event('algorithm-hash-create', { arguments: argsRecord(args) });
        return actualCreateHash(...args);
      });
      syncBuiltinESMExports();
      openSpy = spyOn(fs, 'open');
      openSpy.mockImplementation((...args) => trackOpen(args, kind === 'replacement' && armed && classify(args[0]) === 'target'));
      if (kind === 'unscoped') openSpy.mockImplementationOnce((...args) => trackOpen(args, true));
      lstatSpy = spyOn(fs, 'lstat').mockImplementation(async (...args) => {
        assert.equal(classify(args[0]), 'target', 'unexpected non-target lstat');
        assert(++receipt.counts.algorithmLstats <= 4, 'pathname stat bound');
        const stage = targetOpenEntered ? 'current-path' : 'preview';
        const start = event('algorithm-stat-enter', { method: 'fs.lstat', stage, arguments: argsRecord(args) });
        const stat = await actual.lstat(...args);
        const end = event('algorithm-stat-return', { entered: start.order, method: 'fs.lstat', stage, result: stats(stat) });
        await companion('fs.lstat', stage, options => actual.lstat(args[0], options), args[1], end.order);
        if (stage === 'preview') previewReturned++;
        return stat;
      });
      // Deliberate exported fs.open before sha256File and its first lstat, not an inferred coverage event.
      event('controlled-unrelated-open-before-algorithm');
      const auxiliary = await fs.open(unrelated, 'r');
      await auxiliary.close();
      check('unrelated call leaves target-scoped injection armed', kind !== 'replacement' || (armed && !swapped));
      hashStarted = true;
      receipt.counts.hashCalls++;
      event('hash-call');
      try { receipt.outcome = { resolved: await sha256File(target) }; }
      catch (error) { receipt.outcome = { rejected: errorInfo(error) }; }
      event('hash-settled', receipt.outcome);
      receipt.openSpyCalls = openSpy.mock.calls.map((args, index) => ({ index: index + 1,
        invocationOrder: openSpy.mock.invocationCallOrder[index], classification: classify(args[0]),
        arguments: classify(args[0]) === 'other' ? '[withheld]' : argsRecord(args) }));
      receipt.lstatSpyInvocationOrder = [...lstatSpy.mock.invocationCallOrder];
      openSpy.mockRestore(); openSpy = undefined;
      lstatSpy.mockRestore(); lstatSpy = undefined;
      receipt.finalTarget = await retained(swapped ? 'replacement' : 'unchanged original', target);
      if (swapped) receipt.finalDisplaced = await retained('rename-retained original', displaced);
      const expectedContent = kind === 'stable' ? 'original' : 'replacement';
      const resolved = receipt.outcome.resolved;
      const rejected = receipt.outcome.rejected;
      const shouldReject = kind === 'replacement' && values.variant === 'patched';
      check('fixture content retained', receipt.finalTarget.contentUtf8 === expectedContent &&
        (!swapped || receipt.finalDisplaced.contentUtf8 === 'original'));
      check('exact initial and final original identity is known', known(receipt.beforeAdditional.identity) &&
        known((receipt.finalDisplaced ?? receipt.finalTarget).identity));
      check('rename retains original exact identity', equalId(receipt.beforeAdditional.identity,
        (receipt.finalDisplaced ?? receipt.finalTarget).identity));
      check('replacement exact identity known and distinct', !swapped ||
        (known(receipt.finalTarget.identity) && !equalId(receipt.finalDisplaced.identity, receipt.finalTarget.identity)));
      check('exactly one target open and close, one controlled unrelated open/close',
        receipt.counts.targetOpens === 1 && receipt.counts.closes === 1 && receipt.counts.closed === 1 &&
        receipt.counts.unrelatedOpens === 1 && receipt.counts.unrelatedCloses === 1 && receipt.counts.otherOpens === 0);
      check('one hash invocation, no hash creation before rejection', receipt.counts.hashCalls === 1 &&
        receipt.counts.jsHashCreates === (resolved ? 1 : 0));
      check('native off tripwire untouched', receipt.counts.nativeCalls === 0 && receipt.counts.nativeLoaderCalls === 0);
      check('one swap only for replacement cases', receipt.counts.swaps === (kind === 'stable' ? 0 : 1));
      check('expected outcome', shouldReject ? rejected?.code === 'path-mismatch' :
        kind === 'replacement' ? Boolean(resolved || rejected?.code === 'path-mismatch') : Boolean(resolved));
      check('resolved digest and byte count match retained bytes', !resolved ||
        (resolved.digest === digest(expectedContent) && resolved.bytes === Buffer.byteLength(expectedContent) &&
          receipt.counts.bytesRead === resolved.bytes && receipt.counts.reads > 0));
      check('rejection occurs before any read/native hash', !rejected ||
        (receipt.counts.reads === 0 && receipt.counts.jsHashCreates === 0 && receipt.counts.nativeCalls === 0));
      const previews = receipt.events.filter(e => e.type === 'algorithm-stat-return' && e.stage === 'preview');
      const swapDone = receipt.events.find(e => e.type === 'swap-complete');
      check('swap timing exactly as labeled', kind === 'stable' ||
        (previews.length > 0 && (kind === 'replacement' ?
          previews.every(e => e.order < swapDone.order && !e.swapped) :
          previews.every(e => e.order > swapDone.order && e.swapped))));
      const algorithmStats = receipt.events.filter(e => e.type === 'algorithm-stat-enter');
      if (values.variant === 'baseline') {
        check('baseline stat options remain numeric defaults', algorithmStats.every(e =>
          e.method === 'fs.lstat' ? e.arguments.length === 1 : e.arguments.length === 0));
      } else {
        check('patched pathname identity stats request bigint', algorithmStats.filter(e => e.method === 'fs.lstat')
          .every(e => e.arguments[1]?.value?.bigint === true));
        const firstDescriptor = algorithmStats.find(e => e.method === 'FileHandle.stat');
        check('patched descriptor identity stat requests bigint', firstDescriptor?.arguments[0]?.value?.bigint === true);
      }
      const targetCall = receipt.openSpyCalls.find(e => e.classification === 'target');
      const flags = targetCall?.arguments[1]?.value;
      const expectedFlags = constants.O_RDONLY | (process.platform === 'win32' ? 0 :
        (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      check('target open flags unchanged', typeof flags === 'number' && flags === expectedFlags);
      receipt.classification = kind === 'replacement' && resolved ?
        (values.variant === 'baseline' ? 'BASELINE OBSERVATION: replacement admitted (NOT a security pass)' :
          'PATCH GATE FAILURE: replacement admitted') :
        kind === 'unscoped' ? 'CONTROLLED HAZARD: preview already observes replacement' :
        rejected ? 'replacement rejected before read' : 'stable original hashed';
    } catch (error) { receipt.harnessError = errorInfo(error); }
    finally {
      openSpy?.mockRestore(); lstatSpy?.mockRestore();
      hashSpy?.mockRestore(); syncBuiltinESMExports();
      __resetNativeLoaderForTest(); __resetFsSafeNativeConfigForTest();
      for (const tracked of handles) if (!tracked.closed) {
        receipt.counts.rescueCloses++;
        try { await tracked.raw.close(); } catch (error) { receipt.cleanupError = errorInfo(error); }
      }
      clearTimeout(timer); timer = undefined;
      receipt.passed = !receipt.harnessError && !receipt.cleanupError && receipt.counts.rescueCloses === 0 &&
        receipt.invariants.length > 0 && receipt.invariants.every(i => i.passed);
      write(`${name}.json`, receipt);
      summary.cases.push({ name, passed: receipt.passed, classification: receipt.classification,
        outcome: receipt.outcome, receipt: `${name}.json`, counts: receipt.counts });
      activeCase = undefined;
      console.log(`${name}: ${receipt.passed ? 'diagnostic invariants met' : 'FAIL'} (${receipt.classification ?? 'harness failure'})`);
    }
  }
  await scenario('real-stable', 'stable');
  await scenario('real-target-replacement', 'replacement');
  if (values['include-unscoped']) await scenario('controlled-unscoped-before-preview', 'unscoped');
} catch (error) { summary.error = errorInfo(error); }
finally {
  clearTimeout(timer);
  if (fingerprintBefore) {
    try {
      summary.fingerprintAfter = await fingerprint();
      summary.compiledAndSourceUnchanged = json(summary.fingerprintAfter) === json(fingerprintBefore);
    } catch (error) { summary.fingerprintError = errorInfo(error); }
  }
  summary.finishedAt = new Date().toISOString();
  summary.passed = !summary.error && !summary.fingerprintError && summary.compiledAndSourceUnchanged === true &&
    summary.cases.length >= 2 && summary.cases.every(c => c.passed);
  if (activeCase) summary.incompleteCase = activeCase;
  write('summary.json', summary);
  if (!summary.passed) process.exitCode = 1;
}
