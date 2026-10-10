// Stable seeds complement the minimized regressions in this directory.
export const seeds = [1, 42, 884, 0xdeadbeef];

export function portableScript(seed) {
  const names = ['.dot', 'café', '日本語', 'x'.repeat(180)];
  const name = names[(seed >>> 0) % names.length];
  const data = `seed:${seed}\nλ😀`;
  const op = (method, path, extra = {}) => ({ method, path, options: {}, ...extra });
  return { seed, defaults: { durable: false, mutationSymlinks: 'reject' }, ops: [
    op('write', name, { data }), op('readText', name), op('append', name, { data: '\nappend' }),
    op('create', 'exclusive', { data }), op('create', 'exclusive', { data: 'collision' }),
    op('mkdir', 'nested'), op('copyIn', 'nested/copied', { source: name }),
    op('copySync', 'sync-copy', { source: name }),
    op('copyBatch', 'batch-first', { source: name }), op('copyBatch', 'batch-second', { source: name }),
    op('move', 'sync-copy', { to: 'moved', options: { overwrite: true } }),
    op('stat', 'moved'), op('copyIn', 'nested/second', { source: name }),
    op('list', 'nested'), op('walk', 'nested', { options: { order: 'sorted', symlinkPolicy: 'skip' } }),
    op('writeJson', 'data.json', { data: { seed, name, isFile: true, mode: 123, path: 'literal\\payload' } }), op('readJson', 'data.json'),
    op('lock', 'lock-target'), op('temp', '.', { data }),
    op('remove', 'moved'), op('remove', 'nested/copied'), op('remove', 'nested/second'), op('remove', 'nested'),
  ] };
}

export const allowedDifferences = Object.freeze({
  transferMethod: 'clone/copy-file-range/copy report the mechanism; byte hashes, counts, identities and trees must agree.',
  windowsMode: 'Windows mode bits are not POSIX permissions; cross-OS comparisons omit modes only when Windows participates.',
  symlinkMode: 'Linux and macOS report different mode bits for symlinks; link targets stay strict and regular-file/directory permissions remain compared.',
  unicodeSpelling: 'Cross-OS pathname comparison uses NFC for filesystem spelling; returned text and JSON values stay literal.',
  directorySize: 'Directory/link sizes and directory link counts are filesystem representations, not portable data lengths.',
  nativeCapabilities: 'Broad replay reports native-only capability refusals, including no-clobber move, bounded Windows removal, and restrictive writable-open handoff. The portable corpus does not request them.',
  legacyLinks: 'Broad replay reports Windows omitted-policy writer differences and standalone walker ordering. Portable scripts select explicit mutation link rejection and sorted Root walking.',
  implicitParentLinks: 'With omitted mutationSymlinks, POSIX native beneath creation can refuse absolute parent links, while legacy overwrite move guards refuse parent aliases accepted by retained native moves. Explicit follow-parents-within-root canonicalizes first; reject refuses them uniformly. These historical defaults remain visible in broad replay.',
});

export function portableReport(report, spec, windows = false) {
  const visit = (value, field = '') => {
    if (typeof value === 'string' && ['path', 'realPath', 'relativePath', 'target', 'name'].includes(field)) return value.normalize('NFC');
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !(key === 'mode' && (windows || value.kind === 'symlink')))
      .map(([key, item]) => [key, visit(item, key)]));
    return value;
  };
  const snapshot = tree => visit(tree).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { initial: snapshot(report.initial), results: report.results.map((result, index) => ({ ...result,
    ...(result.tree ? { tree: snapshot(result.tree) } : {}),
    // JSON and text payloads are data, including objects with pathname-like keys.
    ...(['stat', 'walk', 'open', 'temp'].includes(spec.ops[index].method) ? { value: visit(result.value) } : {}),
  })), final: snapshot(report.final) };
}
