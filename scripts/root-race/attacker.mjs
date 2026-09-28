import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(process.argv[2]);
let running = false;
let started = false;
let cycles = 0;
let failures = 0;
let links = 0;
let exchanges = 0;
let state = cfg.seed >>> 0 || 1;
const pauseWord = new Int32Array(new SharedArrayBuffer(4));
const dwellScale = cfg.dwellScale ?? 1;
if (!Number.isFinite(dwellScale) || dwellScale <= 0 || dwellScale > 100) throw new Error('Invalid attacker dwell scale');
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
const dwell = () => Atomics.wait(pauseWord, 0, 0, ((random() % 5) / 10) * dwellScale);
const attempt = fn => { try { fn(); return true; } catch { failures++; return false; } };
const link = (to, at, directory = true) => {
  if (attempt(() => fs.symlinkSync(to, at, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'))) links++;
};
const unlinkAlias = at => { try { if (fs.lstatSync(at).isSymbolicLink()) fs.unlinkSync(at); } catch {} };
const { slot, parked, outside, denied, kind } = cfg;
function replenish(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) return;
    // Only this worker changes this slot's links. The victim never creates
    // aliases, so after restoration these fixture writes cannot reach a sentinel.
    attempt(() => fs.mkdirSync(path.join(directory, 'tree')));
    attempt(() => fs.writeFileSync(path.join(directory, 'tree', 'data'), 'IN_ROOT\n', { flag: 'wx' }));
    attempt(() => fs.writeFileSync(path.join(directory, 'data'), 'IN_ROOT\n', { flag: 'wx' }));
    attempt(() => fs.rmSync(path.join(directory, 'new'), { force: true }));
    attempt(() => fs.rmSync(path.join(directory, 'append-created'), { force: true }));
    attempt(() => fs.rmSync(path.join(directory, 'moved'), { force: true }));
    attempt(() => fs.rmSync(path.join(directory, 'new-dir'), { recursive: true, force: true }));
  } catch {}
}
function step() {
  // A victim may create a replacement directory while our name is absent.
  // Remove only that disposable attacker slot, never a symlink referent.
  if (fs.existsSync(parked)) {
    attempt(() => fs.rmSync(slot, { recursive: true, force: true }));
    attempt(() => fs.renameSync(parked, slot));
  }
  if (kind === 'ancestor') {
    if (attempt(() => fs.renameSync(slot, parked))) {
      link(outside, slot);
      dwell();
      unlinkAlias(slot);
      attempt(() => fs.renameSync(parked, slot));
    }
  } else if (kind === 'hardlink' || kind === 'type-flip') {
    const leaf = path.join(slot, 'data');
    attempt(() => fs.rmSync(leaf, { recursive: true, force: true }));
    if (kind === 'hardlink') {
      if (attempt(() => fs.linkSync(path.join(outside, 'data'), leaf))) links++;
    } else if (random() % 2) {
      link(path.join(outside, 'data'), leaf, false);
    } else {
      attempt(() => fs.mkdirSync(leaf));
    }
    dwell();
    attempt(() => fs.rmSync(leaf, { recursive: true, force: true }));
    attempt(() => fs.writeFileSync(leaf, 'IN_ROOT\n', { flag: 'wx' }));
  } else if (kind === 'directory-replace') {
    if (attempt(() => fs.renameSync(slot, parked))) {
      if (attempt(() => fs.renameSync(cfg.alternate, slot))) exchanges++;
      dwell();
      attempt(() => fs.renameSync(slot, cfg.alternate));
      attempt(() => fs.renameSync(parked, slot));
    }
  } else {
    if (attempt(() => fs.renameSync(slot, parked))) {
      link(random() % 2 ? outside : denied, slot);
      dwell();
      if (kind === 'retarget') {
        unlinkAlias(slot);
        link(random() % 2 ? denied : outside, slot);
        dwell();
      }
      unlinkAlias(slot);
      attempt(() => fs.renameSync(parked, slot));
    }
  }
  if (kind === 'ancestor') {
    try {
      if (fs.lstatSync(slot).isDirectory()) {
        for (let lane = 0; lane < cfg.count; lane++) replenish(path.join(slot, 'root', `slot${lane}`));
      }
    } catch {}
  } else replenish(slot);
  cycles++;
  // Leave a real-directory interval, so both admission and post-admission
  // races are exercised instead of almost exclusively rejecting stable links.
  dwell();
}
function batch() {
  if (!running) {
    // Restore only attacker-owned names; never follow or recursively remove a sentinel.
    unlinkAlias(slot);
    if (fs.existsSync(parked)) {
      attempt(() => fs.rmSync(slot, { recursive: true, force: true }));
      attempt(() => fs.renameSync(parked, slot));
    }
    if (process.connected) {
      process.send({ done: true, cycles, failures, links, exchanges });
      process.disconnect();
    }
    return;
  }
  const begin = String(process.hrtime.bigint());
  const linksBefore = links;
  const exchangesBefore = exchanges;
  for (let i = 0; i < 8; i++) step();
  if (process.connected) process.send({ activity: true, begin, end: String(process.hrtime.bigint()),
    links: links - linksBefore, exchanges: exchanges - exchangesBefore }, () => {});
  setImmediate(batch);
}
process.on('message', msg => {
  if (msg === 'start' && !started) { started = true; running = true; process.send?.({ started: true }); batch(); }
  if (msg === 'stop') running = false;
});
function stop() {
  running = false;
  if (!started) { started = true; batch(); }
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.send?.({ ready: true });
