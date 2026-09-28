import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { root } from '../../dist/root.js';
import { configureFsSafeNative } from '../../dist/config.js';
import { fileStore } from '../../dist/store.js';
import { acquireFileLock } from '../../dist/file-lock.js';
import { tempWorkspace } from '../../dist/temp.js';
import { getNativeBinding } from '../../dist/native.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const mode = args.mode ?? 'require';
const verdict = args.verdict ?? 'strict';
if (!['strict', 'observe'].includes(verdict)) throw new Error('verdict must be strict or observe');
configureFsSafeNative({ mode });
const seeds = Number(args.seeds ?? 60);
const seconds = Number(args.seconds ?? 20);
const startSeed = Number(args.seed ?? 1);
const kinds = ['parent-symlink', 'retarget', 'directory-replace', 'hardlink', 'type-flip', 'ancestor'];
if (!Number.isSafeInteger(seeds) || seeds < 1 || !Number.isSafeInteger(startSeed) || startSeed < 1 ||
    !Number.isFinite(seconds) || seconds < 0 || (!args.control && seconds === 0)) throw new Error('Invalid seed count, seed, or duration');
if (args.kind && !kinds.includes(args.kind)) throw new Error('Unknown attacker kind');
if (args.control && !['quiet', 'oracle'].includes(args.control)) throw new Error('Unknown control');
const output = path.resolve(args.output ?? `race-${process.platform}-${mode}.jsonl`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, '', { flag: 'wx' });
const record = value => { const text = JSON.stringify(value); fs.appendFileSync(output, text + '\n'); console.log(text); };
const native = getNativeBinding();
if (mode === 'require' && !native) throw new Error('Required native binding did not load');
let nativeContainment = null;
if (native && process.platform !== 'win32') {
  const fd = fs.openSync(os.tmpdir(), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    const result = native.openBeneath(fd, '.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    nativeContainment = result.containment;
    fs.closeSync(result.fd);
  } finally { fs.closeSync(fd); }
}
record({ event: 'configuration', platform: process.platform, arch: process.arch, node: process.version,
  mode, nativeLoaded: Boolean(native), nativeContainment, noOpenat2: process.env.FS_SAFE_TEST_NO_OPENAT2 ?? null, seeds, seconds, startSeed });

function snapshot(dir, prefix = '') {
  const entries = {};
  function visit(current, relative) {
    const stat = fs.lstatSync(current, { bigint: true });
    entries[relative] = { ino: String(stat.ino), dev: String(stat.dev), mode: String(stat.mode),
      type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
      data: stat.isFile() ? fs.readFileSync(current).toString('base64') : stat.isSymbolicLink() ? fs.readlinkSync(current) : null };
    if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), `${relative}/${name}`);
  }
  try { visit(dir, prefix); } catch (error) { entries.snapshotError = { code: error.code }; }
  return entries;
}
function differences(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => ({ path: key, before: before[key], after: after[key] }));
}
function populate(dir, sentinel = false) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tag = sentinel === 'denied' ? 'DENIED' : 'OUTSIDE';
  for (const name of ['data', 'target', 'state.json', 'victim.lock']) {
    const value = sentinel ? `${tag}_SENTINEL:${name}` : 'IN_ROOT';
    const content = name.endsWith('.json') ? JSON.stringify({ value }) : value;
    fs.writeFileSync(path.join(dir, name), content + '\n', { mode: 0o644 });
  }
  fs.mkdirSync(path.join(dir, 'tree'), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'tree', 'data'), sentinel ? `${tag}_SENTINEL:tree\n` : 'IN_ROOT\n');
  if (sentinel) fs.writeFileSync(path.join(dir, `${tag}_ONLY`), `${tag}_SENTINEL:listing\n`);
}
function readable(value) {
  const text = Buffer.isBuffer(value) ? value.toString() : typeof value === 'string' ? value : JSON.stringify(value);
  if (text?.includes('OUTSIDE_SENTINEL') || text?.includes('OUTSIDE_ONLY')) throw Object.assign(new Error('Outside sentinel returned'), { escape: true });
}
async function runSeed(seed) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-safe-root-race-'));
  fs.chmodSync(base, 0o700);
  const top = path.join(base, 'top');
  const rootDir = path.join(top, 'root');
  const outside = path.join(base, 'outside');
  const denied = path.join(rootDir, 'denied');
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  populate(outside, true);
  populate(denied, 'denied');
  // An ancestor junction targets outside/root, matching top/root's layout.
  populate(path.join(outside, 'root'), true);
  const count = 1 + (Math.floor((seed - 1) / 6) % 4);
  const kind = args.kind ?? kinds[(seed - 1) % kinds.length];
  const workers = [];
  const workerExits = new Map();
  const overlappingAttackers = new Set();
  let victimStart;
  let victimEnd;
  const attackerResults = [];
  const mutationSymlinks = [undefined, 'reject', 'follow-parents-within-root'][Math.floor((seed - 1) / 6) % 3];
  const rootHandle = await root(rootDir, { durable: false, hardlinks: 'reject', symlinks: 'reject',
    mutationSymlinks, denyMutations: { prefixes: [denied] } });
  const store = fileStore({ rootDir, durable: false });
  for (let lane = 0; lane < count; lane++) {
    const slot = path.join(rootDir, `slot${lane}`);
    populate(slot);
    populate(path.join(rootDir, `alternate${lane}`));
    populate(path.join(outside, 'root', `slot${lane}`), true);
    // FileStore has no denyMutations contract; classify its observations separately.
  }
  const initialOutside = snapshot(outside, 'outside');
  const initialDenied = snapshot(denied, 'denied');
  let previousOutside = initialOutside;
  let previousDenied = initialDenied;
  let rng = seed >>> 0 || 1;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return rng >>> 0; };
  const metrics = {};
  const observations = [];
  const observationCounts = { readEscape: 0, outsideChanges: 0, deniedChanges: 0 };
  const observationByOperation = {};
  const copyVerification = { inspected: 0, missed: 0, errors: {} };
  const inconclusiveReads = new Set();
  const contentReadOperations = new Set(['read', 'readBytes', 'open', 'readJson', 'copy']);
  let currentCall;
  function observe(call, category, details) {
    observationCounts[category]++;
    const key = `${call.operation}:${category}`;
    observationByOperation[key] = (observationByOperation[key] ?? 0) + 1;
    if (observationByOperation[key] <= 3) observations.push({ ...call, [category]: details });
  }
  function inspectTrees(call) {
    const afterOutside = snapshot(outside, 'outside');
    // Do not attribute the attacker's own ancestor rename to the victim.
    if (kind !== 'ancestor') {
      const afterDenied = snapshot(denied, 'denied');
      const diff = differences(previousDenied, afterDenied);
      if (diff.length) observe(call, 'deniedChanges', diff);
      previousDenied = afterDenied;
    }
    const diff = differences(previousOutside, afterOutside);
    if (diff.length) observe(call, 'outsideChanges', diff);
    previousOutside = afterOutside;
  }
  function inspectCopy(receipt) {
    let fd;
    try {
      fd = fs.openSync(receipt.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.dev !== receipt.dev || stat.ino !== receipt.ino) { copyVerification.missed++; return; }
      copyVerification.inspected++;
      readable(fs.readFileSync(fd));
    } catch (error) {
      if (error.escape) observe(currentCall, 'readEscape', { source: 'published-copy' });
      else { const code = error.code ?? error.name; copyVerification.errors[code] = (copyVerification.errors[code] ?? 0) + 1; }
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const recent = [];
  let operations = 0;
  const payload = 'VICTIM_WRITE\n';
  let unsupported = 0;
  let stopped = false;
  async function waitForWorker(child, field) {
    let timer;
    let listener;
    try {
      await Promise.race([
        new Promise(resolve => { listener = msg => { if (msg[field]) resolve(); }; child.on('message', listener); }),
        workerExits.get(child).then(() => { throw new Error('Attacker exited during startup'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Attacker startup timed out')), 15000); }),
      ]);
    } finally { clearTimeout(timer); child.off('message', listener); }
  }
  const makeWorker = async config => {
    const child = fork(new URL('./attacker.mjs', import.meta.url), [JSON.stringify(config)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    workerExits.set(child, new Promise(resolve => child.once('close', resolve)));
    child.on('error', () => {}); // close settles startup and shutdown on spawn failure.
    child.on('message', msg => {
      if (msg.done) attackerResults.push(msg);
      if (msg.activity && victimStart !== undefined && BigInt(msg.begin) >= victimStart &&
          (victimEnd === undefined || BigInt(msg.end) <= victimEnd) &&
          (kind === 'directory-replace' ? msg.exchanges > 0 : msg.links > 0)) overlappingAttackers.add(child);
    });
    workers.push(child);
    await waitForWorker(child, 'ready');
  };
  const methods = {
    read: async p => readable((await rootHandle.read(`${p}/data`)).buffer),
    readBytes: async p => readable(await rootHandle.readBytes(`${p}/data`)),
    open: async p => { const result = await rootHandle.open(`${p}/data`); try { readable(await result.handle.readFile()); } finally { await result.handle.close(); } },
    write: p => rootHandle.write(`${p}/data`, payload, { mode: 0o600 }),
    create: p => rootHandle.create(`${p}/new`, payload, { mode: 0o600 }),
    append: p => rootHandle.append(`${p}/data`, payload),
    appendCreate: p => rootHandle.append(`${p}/append-created`, payload),
    mkdir: p => rootHandle.mkdir(`${p}/new-dir/deep`),
    move: p => rootHandle.move(`${p}/data`, `${p}/moved`),
    rename: p => rootHandle.move(`${p}/data`, `${p}/target`, { overwrite: true }),
    copy: p => rootHandle.copyIn(`${p}/target`, { root: rootHandle, relativePath: `${p}/data` }, { onDestinationPublished: inspectCopy }),
    remove: p => rootHandle.remove(`${p}/data`),
    removeTree: p => rootHandle.remove(`${p}/tree`, { recursive: true }),
    list: async p => readable(await rootHandle.list(p)),
    walk: async p => { for await (const entry of rootHandle.walk(p, { symlinkPolicy: 'skip', maxEntries: 30 })) readable(entry); },
    chmod: async p => { const result = await rootHandle.openWritable(`${p}/data`, { writeMode: 'append' }); try { await result.handle.chmod(0o600); } finally { await result.handle.close(); } },
    openWritable: async p => { const result = await rootHandle.openWritable(`${p}/data`, { writeMode: 'append' }); try { await result.handle.write(payload); } finally { await result.handle.close(); } },
    writeJson: p => rootHandle.writeJson(`${p}/state.json`, { inside: true }),
    readJson: async p => readable(await rootHandle.readJson(`${p}/state.json`)),
    fileStore: p => store.write(`${p}/data`, payload),
    storeJson: p => store.json(`${p}/state.json`).write({ inside: true }),
    lock: async p => { const lock = await acquireFileLock(path.join(rootDir, p, 'data'), { lockRoot: rootHandle, payload: () => ({ pid: process.pid, seed }), retry: { retries: 0 }, timeoutMs: 10 }); try { inspectTrees(currentCall); } finally { await lock.release(); } },
    temp: async p => { const workspace = await tempWorkspace({ rootDir: path.join(rootDir, p), prefix: 'race-', cleanupSafety: 'compatible' }); try { await workspace.write('data', payload); } finally { try { inspectTrees(currentCall); } finally { await workspace.cleanup(); } } },
    tempBounded: async p => { const workspace = await tempWorkspace({ rootDir: path.join(rootDir, p), prefix: 'bounded-', cleanupSafety: 'require-bounded' }); try { await workspace.write('data', payload); } finally { try { inspectTrees(currentCall); } finally { await workspace.cleanup(); } } },
  };
  const requested = args.ops ? args.ops.split(',') : Object.keys(methods);
  const selected = args.control === 'oracle' ? requested.slice(0, 1) : requested;
  for (const name of selected) if (!methods[name]) throw new Error(`Unknown operation ${name}`);
  let started;
  try {
    for (let lane = 0; lane < (args.control ? 0 : kind === 'ancestor' ? 1 : count); lane++) {
      await makeWorker({ seed: seed * 31 + lane, kind, count,
        slot: kind === 'ancestor' ? top : path.join(rootDir, `slot${lane}`),
        parked: kind === 'ancestor' ? path.join(base, 'top-parked') : path.join(rootDir, `parked${lane}`),
        alternate: path.join(rootDir, `alternate${lane}`), outside, denied });
    }
    await Promise.all(workers.map(async child => {
      const started = waitForWorker(child, 'started');
      child.send('start');
      await started;
    }));
    victimStart = process.hrtime.bigint();
    started = Date.now();
    const deadline = started + seconds * 1000;
    while (Date.now() < deadline || (args.control && operations < selected.length)) {
      const method = args.control && operations < selected.length ? selected[operations] : selected[random() % selected.length];
      const lane = random() % count;
      const p = `slot${lane}`;
      if (args.control) {
        fs.rmSync(path.join(rootDir, p), { recursive: true, force: true });
        populate(path.join(rootDir, p));
      }
      const entry = metrics[method] ??= { attempts: 0, success: 0, errors: {} };
      entry.attempts++;
      const call = { operation: method, path: p, iteration: operations };
      currentCall = call;
      // A prior escaping writer may have destroyed a marker used by a later
      // reader. Keep that operation inconclusive even if its read finds no marker.
      if ((observationCounts.outsideChanges || observationCounts.deniedChanges) && contentReadOperations.has(method)) inconclusiveReads.add(method);
      recent.push(call); if (recent.length > 8) recent.shift();
      try { await methods[method](p); entry.success++; } catch (error) {
        const code = error.code ?? error.name;
        entry.errors[code] = (entry.errors[code] ?? 0) + 1;
        if (code === 'helper-unavailable') unsupported++;
        if (error.escape) observe(call, 'readEscape', true);
        if (error instanceof TypeError) throw error;
      }
      operations++;
      if (args.control === 'oracle' && operations === 1) fs.writeFileSync(path.join(outside, 'data'), 'ORACLE_CONTROL');
      // Snapshot every operation for attribution; attackers never modify these trees.
      inspectTrees(call);
      if (args.control === 'oracle') break;
    }
  } finally {
    victimEnd = process.hrtime.bigint();
    for (const child of workers) if (child.connected) child.send('stop');
    const deadlineTimer = setTimeout(() => { for (const child of workers) if (child.exitCode === null) child.kill('SIGKILL'); }, 15000);
    await Promise.all(workerExits.values());
    clearTimeout(deadlineTimer);
    stopped = true;
  }
  const finalOutside = differences(initialOutside, snapshot(outside, 'outside'));
  const finalDenied = differences(initialDenied, snapshot(denied, 'denied'));
  const result = { event: 'seed', seed, kind, mutationSymlinks: mutationSymlinks ?? 'default', attackers: workers.length, elapsedMs: Date.now() - started,
    operations, metrics, unsupported, attackerResults, observations, observationCounts, observationByOperation, copyVerification,
    finalOutside, finalDenied, stopped, allAttackersReported: attackerResults.length === workers.length,
    inconclusiveReads: [...inconclusiveReads],
    unexercisedOperations: selected.filter(name => !metrics[name]?.success),
    unavailableOperations: selected.filter(name => metrics[name]?.errors['helper-unavailable'] > 0),
    attackersExercised: Boolean(args.control) || overlappingAttackers.size === workers.length,
    copyChecksComplete: copyVerification.missed === 0 && Object.keys(copyVerification.errors).length === 0 };
  record(result);
  // All attacker processes have exited. rm never traverses final symlinks/junctions.
  fs.rmSync(base, { recursive: true, force: true });
  return result;
}
let affectedSeeds = 0;
let incompleteSeeds = 0;
for (let i = 0; i < seeds; i++) {
  const result = await runSeed(startSeed + i);
  if (result.observations.length || result.finalOutside.length || result.finalDenied.length) affectedSeeds++;
  if (!result.operations || !result.allAttackersReported || !result.attackersExercised || result.unexercisedOperations.length || result.unavailableOperations.length || result.inconclusiveReads.length || !result.copyChecksComplete) incompleteSeeds++;
}
record({ event: 'complete', seeds, affectedSeeds, incompleteSeeds, verdict });
// Observe mode is for contract classification, never a clean security gate.
// The oracle control must detect its intentional corruption to pass.
if (args.control === 'oracle') process.exitCode = affectedSeeds > 0 && incompleteSeeds === 0 ? 0 : 1;
else if (verdict === 'strict') process.exitCode = affectedSeeds > 0 ? 1 : incompleteSeeds > 0 ? 2 : 0;
