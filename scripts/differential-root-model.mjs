import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const encode = value => JSON.stringify(value, (_, v) => v === Infinity ? "$Infinity"
  : typeof v === "string" && v.startsWith("$") ? `$${v}` : v);
export const decode = value => JSON.parse(value, (_, v) => v === "$Infinity" ? Infinity
  : typeof v === "string" && v.startsWith("$$") ? v.slice(1) : v);
export const errorValue = error => ({ name: error?.name ?? typeof error, code: error?.code ?? null, category: error?.category ?? null });

function rng(seed) {
  let n = seed >>> 0 || 1;
  return values => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return values[(n >>> 0) % values.length]; };
}
export function generate(seed, length, ci = false) {
  const pick = rng(seed);
  const paths = ['file', 'empty', 'dir/child', 'new', 'missing/new', 'dir', 'missing', 'file/child', 'link', 'alias/new', 'dangling', 'hard', 'hard-peer', 'deny/new'];
  const methods = ['write', 'create', 'append', 'copyIn', 'read', 'readText', 'open', 'openWritable', 'stat', 'exists', 'list', 'entries', 'walk', 'remove', 'mkdir', 'resolve', 'writeJson', 'createJson', 'move', 'atomic', 'walkDirectory', 'hash'];
  const ops = [];
  const mode = () => pick([undefined, 0o600, 0o640, 0o644, 0o700, 0o777]);
  const cap = () => pick([undefined, 0, 1, 4, 32, Number.MAX_SAFE_INTEGER, Infinity]);
  const mutation = () => ({ mutationSymlinks: pick([undefined, 'reject', 'follow-parents-within-root']) });
  for (let i = 0; i < length; i++) {
    const method = i < methods.length ? methods[(i + seed) % methods.length] : pick(methods);
    const op = { method, path: pick(paths), options: {}, data: pick(['', 'x', 'hello\n', 'one\ntwo', 'λ😀']) };
    const o = op.options;
    if (['write', 'create', 'append', 'writeJson', 'createJson'].includes(method)) {
      Object.assign(o, mutation(), { mode: mode(), mkdir: pick([undefined, false, true]), durable: false, encoding: pick([undefined, 'utf8', 'utf16le']), });
      if (['write', 'writeJson'].includes(method)) o.overwrite = pick([undefined, false, true]);
      if (['create', 'createJson'].includes(method)) o.atomic = pick([undefined, false, true]);
      if (method === 'append') o.prependNewlineIfNeeded = pick([undefined, false, true]);
      if (method.endsWith('Json')) { op.data = pick([null, false, 0, '', {a: 1}, [1, 'x']]); o.space = pick([undefined, 0, 2, 10]); o.trailingNewline = pick([undefined, true, false]); }
    } else if (method === 'copyIn') {
      op.source = pick(['file', 'empty', 'dir/child', 'hard', 'link', 'dir', 'missing']);
      Object.assign(o, mutation(), { mode: mode(), mkdir: pick([undefined, false, true]), durable: false, overwrite: pick([undefined, false, true]), clone: pick(['never', 'auto']), maxBytes: cap(), preserveSourceMode: pick([undefined, true, false]), sourceHardlinks: pick([undefined, 'reject', 'allow']) });
    } else if (['read', 'readText', 'open'].includes(method)) {
      Object.assign(o, { symlinks: pick([undefined, 'reject', 'follow-within-root', 'follow-parents-within-root']), hardlinks: pick([undefined, 'reject', 'allow']) });
      if (method !== 'open') o.maxBytes = cap();
    } else if (method === 'openWritable') {
      Object.assign(o, mutation(), { mode: mode(), mkdir: pick([undefined, false, true]), writeMode: pick(['replace', 'append', 'update']) });
    } else if (method === 'remove') {
      Object.assign(o, mutation(), { recursive: pick([undefined, false, true]), force: pick([undefined, false, true]), order: 'sorted', maxEntries: pick([undefined, 0, 1, 8, Infinity]), maxDepth: pick([undefined, 0, 1, 3, Infinity]) });
    } else if (method === 'mkdir') Object.assign(o, mutation());
    else if (method === 'move') { op.to = pick(paths); Object.assign(o, mutation(), { overwrite: true }); }
    else if (method === 'list') { op.path = pick(['.', 'dir', 'alias', 'missing', 'file']); o.withFileTypes = pick([false, true]); }
    else if (method === 'entries') { op.path = pick(['.', 'dir', 'alias', 'missing', 'file']); Object.assign(o, {order: 'sorted', maxEntries: pick([undefined, 0, 1, 8, 30]), symlinks: pick([undefined, 'reject', 'follow-within-root', 'follow-parents-within-root'])}); }
    else if (method === 'walk') { op.path = pick(['.', 'dir', 'alias', 'missing', 'file']); Object.assign(o, { order: 'sorted', symlinkPolicy: pick(['skip', 'include', 'follow-within-root']), maxDepth: pick([undefined, 0, 1, 3]), maxEntries: pick([undefined, 0, 1, 8, 30]), limitBehavior: pick(['truncate', 'throw']) }); }
    else if (method === 'walkDirectory') { op.path = pick(['.', 'dir', 'alias', 'missing', 'file']); Object.assign(o, { symlinks: pick(['skip', 'include', 'follow']), maxDepth: pick([undefined, 0, 1, 3]), maxEntries: pick([undefined, 0, 1, 8, 30]) }); }
    else if (method === 'atomic') Object.assign(o, {mode: mode(), dirMode: pick([undefined, 0o700, 0o755]), preserveExistingMode: pick([undefined, false, true]), syncTempFile: pick([false, true]), syncParentDir: pick([false, true]), destinationHardlinks: pick([undefined, 'reject'])});
    if (ci) {
      // Explicit link rejection avoids the documented Windows legacy-path delta.
      if (["write", "create", "append", "copyIn", "openWritable", "remove", "mkdir", "move", "writeJson", "createJson"].includes(method)) {
        o.mutationSymlinks = "reject";
      }
      // Directory collisions have their own public differential regression.
      // Keep this independent corpus usable before that behavior fix lands.
      if (["create", "createJson"].includes(method) || o.overwrite === false) op.path = `exclusive-${i}`;
      if (method === "walkDirectory") {
        op.path = "dir";
        o.symlinks = "skip";
        delete o.maxEntries;
      }
    }
    ops.push(op);
  }
  return { seed, defaults: { durable: false }, ops };
}

const methods = new Set(["write", "create", "append", "copyIn", "read", "readText",
  "open", "openWritable", "stat", "exists", "list", "entries", "walk", "remove",
  "mkdir", "resolve", "writeJson", "createJson", "move", "atomic", "walkDirectory", "hash"]);

export function validateSpec(spec) {
  if (!spec || !Array.isArray(spec.ops) || spec.ops.length < 1 || spec.ops.length > 1000) {
    throw new TypeError("a replay must contain 1–1000 operations");
  }
  const object = value => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value));
  if (!object(spec.defaults)) throw new TypeError("defaults must be an object");
  const fixturePath = value => {
    if (value === ".") return;
    if (typeof value !== "string" || path.isAbsolute(value) || value.split("/").some(
      part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || part.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )) throw new TypeError("replay paths must be portable fixture-relative names");
  };
  for (const op of spec.ops) {
    if (!op || !methods.has(op.method) || !object(op.options)) throw new TypeError("invalid replay operation");
    fixturePath(op.path);
    if (op.method === "atomic" && op.path === ".") throw new TypeError("atomic writes require a fixture leaf");
    if (op.method === "copyIn") fixturePath(op.source);
    if (op.method === "move") fixturePath(op.to);
    // JSON cannot supply filesystem adapters, executable callbacks, or streams.
    for (const key of ["filePath", "content", "fileSystem"]) {
      if (op.method === "atomic" && Object.hasOwn(op.options ?? {}, key)) {
        throw new TypeError(`atomic replay options cannot override ${key}`);
      }
    }
  }
  return spec;
}

function comparable(result) {
  // Full standalone scans promise filesystem ordering, not lexical ordering.
  // Bounded subsets and followed-directory aliases remain visible divergences.
  if (result?.value?.scannedEntryCount !== undefined) {
    const byPath = (a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
    return { ...result, value: { ...result.value,
      entries: [...result.value.entries].sort(byPath),
      failedDirs: [...result.value.failedDirs].sort(byPath),
    } };
  }
  return result;
}

export function firstDifference(left, right) {
  if (!isDeepStrictEqual(left.initial, right.initial)) return { phase: "initial" };
  for (let index = 0; index < Math.max(left.results.length, right.results.length); index++) {
    if (!isDeepStrictEqual(comparable(left.results[index]), comparable(right.results[index]))) {
      return { phase: "operation", index };
    }
  }
  return isDeepStrictEqual(left.final, right.final) ? undefined : { phase: "final" };
}

export function shrinkSpec(spec, differs, budget = 200) {
  let current = decode(encode(spec));
  let attempts = 0;
  const accept = next => {
    if (attempts >= budget) return false;
    attempts++;
    if (!differs(next)) return false;
    current = next;
    return true;
  };
  for (let size = Math.floor(current.ops.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= current.ops.length && attempts < budget;) {
      const ops = [...current.ops.slice(0, start), ...current.ops.slice(start + size)];
      if (ops.length && accept({ ...current, ops })) continue;
      start += size;
    }
  }
  for (let index = 0; index < current.ops.length; index++) {
    for (const key of Object.keys(current.ops[index].options ?? {})) {
      const next = decode(encode(current));
      delete next.ops[index].options[key];
      accept(next);
    }
  }
  // Option reduction can make earlier calls redundant; finish at a one-call
  // deletion fixed point when the bounded attempt budget permits it.
  let changed = true;
  while (changed && current.ops.length > 1 && attempts < budget) {
    changed = false;
    for (let index = 0; index < current.ops.length && attempts < budget; index++) {
      const ops = current.ops.filter((_, i) => i !== index);
      if (accept({ ...current, ops })) { changed = true; break; }
    }
  }
  return { spec: current, attempts, exhausted: attempts >= budget };
}
