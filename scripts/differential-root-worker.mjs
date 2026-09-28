import fs from "node:fs";
import path from "node:path";
import { errorValue } from "./differential-root-model.mjs";

const portable = value => value.split(path.sep).join("/");

export function observeAddonLoads() {
  const dlopen = process.dlopen;
  const observation = { loads: [], attempts: 0, restore: () => { process.dlopen = dlopen; } };
  process.dlopen = function(module, filename, ...rest) {
    observation.attempts++;
    const result = Reflect.apply(dlopen, this, [module, filename, ...rest]);
    observation.loads.push(path.basename(filename));
    return result;
  };
  return observation;
}

export async function worker(spec, dir, sync) {
  process.umask(0o022);
  const native = observeAddonLoads();
  const api = await import('../dist/index.js');
  const atomic = await import('../dist/atomic.js');
  const walking = await import('../dist/walk.js');
  const durability = await import('../dist/durability.js');
  const metadata = st => {
    const is = key => typeof st[key] === 'function' ? st[key]() : st[key];
    return { kind: is('isSymbolicLink') ? 'symlink' : is('isDirectory') ? 'directory' : is('isFile') ? 'file' : 'other', ...(is('isFile') ? { size: Number(st.size), nlink: Number(st.nlink) } : {}), ...(process.platform !== 'win32' ? {mode: Number(st.mode) & 0o777} : {}) };
  };
  const normalizePath = value => portable(value.replaceAll(dir, "$ROOT"));
  const normalize = v => {
    if (v === undefined) return { type: "undefined" };
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { bytes: Buffer.from(v).toString('hex') };
    if (v instanceof Error) return errorValue(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'bigint') return String(v);
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      if ('isFile' in v && 'mode' in v) return { ...(v.name ? {name: v.name} : {}), ...metadata(v) };
      return Object.fromEntries(Object.entries(v).filter(([key]) => !['dirent', 'handle'].includes(key)).map(([k,x]) => [
        k, typeof x === "string" && ["path", "realPath", "relativePath"].includes(k) ? normalizePath(x)
          : k === 'size' && v.kind && v.kind !== 'file' ? 0 : normalize(x),
      ]));
    }
    return v;
  };
  function tree(rel = '.') {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    const result = { path: portable(rel), ...metadata(st) };
    if (st.isSymbolicLink()) result.target = portable(fs.readlinkSync(p)).replaceAll(portable(dir), '$ROOT');
    else if (st.isFile()) {
      try { result.content = fs.readFileSync(p).toString('hex'); }
      catch(e) { result.contentError = errorValue(e); }
    }
    const children = st.isDirectory() ? fs.readdirSync(p).sort().flatMap(n => tree(rel === '.' ? n : `${rel}/${n}`)) : [];
    return [result, ...children];
  }
  const results = [];
  try {
    fs.mkdirSync(path.join(dir, 'dir'));
    fs.mkdirSync(path.join(dir, 'deny'));
    fs.writeFileSync(path.join(dir, 'file'), 'alpha\n', {mode: 0o644});
    fs.writeFileSync(path.join(dir, 'empty'), '', {mode: 0o600});
    fs.writeFileSync(path.join(dir, 'dir/child'), 'child', {mode: 0o640});
    fs.writeFileSync(path.join(dir, 'hard'), 'linked', {mode: 0o600});
    fs.linkSync(path.join(dir, 'hard'), path.join(dir, 'hard-peer'));
    fs.symlinkSync('file', path.join(dir, 'link'), 'file');
    fs.symlinkSync('dir', path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync('absent', path.join(dir, 'dangling'), 'file');
    const safe = await api.root(dir, spec.defaults);
    // Exercise one public native-backed operation before every sequence to prove loading.
    await durability.sha256File(path.join(dir, 'file'));
    const initial = tree();
    for (const op of spec.ops) {
      let value;
      const o = op.options ?? {};
      try {
        if (op.method === 'copyIn') value = await safe.copyIn(op.path, path.join(dir, op.source), o);
        else if (op.method === 'move') value = await safe.move(op.path, op.to, o);
        else if (['write', 'create', 'append', 'writeJson', 'createJson'].includes(op.method)) value = await safe[op.method](op.path, op.data, o);
        else if (op.method === 'open' || op.method === 'openWritable') {
          const opened = await safe[op.method](op.path, o);
          try { value = {stat: opened.stat, realPath: opened.realPath, containment: opened.containment}; if(op.method === 'open') value.bytes = await opened.handle.readFile(); else await opened.handle.writeFile(op.data); }
          finally { await opened.handle.close(); }
        } else if (op.method === 'entries' || op.method === 'walk') {
          const partial = [];
          try { for await (const entry of safe[op.method](op.path, o)) partial.push(normalize(entry)); value = partial; }
          catch (e) { results.push({error: errorValue(e), partial, tree: tree()}); continue; }
        } else if (op.method === 'atomic') value = await atomic[sync ? 'replaceFileAtomicSync' : 'replaceFileAtomic']({ filePath: path.join(dir, op.path), content: op.data, ...o });
        else if (op.method === 'walkDirectory') value = await walking[sync ? 'walkDirectorySync' : 'walkDirectory'](path.join(dir, op.path), o);
        else if (op.method === 'hash') value = await durability[sync ? 'sha256FileSync' : 'sha256File'](path.join(dir, op.path));
        else value = await safe[op.method](op.path, o);
        results.push({value: op.method === "resolve" && typeof value === "string" ? normalizePath(value) : normalize(value), tree: tree()});
      } catch (e) { results.push({ error: errorValue(e), tree: tree() }); }
    }
    return {runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`, platform: process.platform, mode: process.env.FS_SAFE_NATIVE_MODE, sync, loads: native.loads, nativeAttempts: native.attempts, initial, results, final: tree()};
  } finally {
    native.restore();
  }
}
