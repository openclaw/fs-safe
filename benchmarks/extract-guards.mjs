// Build both revisions first. ARCHIVE_BASE_DIST points to the baseline dist/.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import JSZip from 'jszip';
import { create as createTar } from 'tar';

async function load(directory) {
  const url = pathToFileURL(path.resolve(directory) + path.sep);
  return { ...await import(new URL('archive.js', url)), ...await import(new URL('config.js', url)) };
}
const baseline = await load(process.env.ARCHIVE_BASE_DIST ?? 'dist');
const candidate = await load(process.env.ARCHIVE_HEAD_DIST ?? 'dist');
const pairs = Number(process.env.ARCHIVE_PAIRS ?? 9);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-guard-pairs-')));

try {
  for (const kind of (process.env.ARCHIVE_KINDS ?? 'zip,tar').split(',')) {
    for (const depth of (process.env.ARCHIVE_DEPTHS ?? '1,4,8').split(',').map(Number)) {
      const fixture = path.join(base, `${kind}-${depth}`);
      const input = path.join(fixture, 'input');
      const nested = Array.from({ length: depth }, (_, i) => `d${i}`).join('/');
      await fs.mkdir(path.join(input, nested), { recursive: true });
      const zip = new JSZip(), names = [];
      for (let i = 0; i < 500; i++) {
        const name = `${nested}/f${String(i).padStart(4, '0')}`;
        const content = Buffer.alloc(1024, i % 251);
        await fs.writeFile(path.join(input, name), content);
        zip.file(name, content, { createFolders: false });
        names.push(name);
      }
      const archivePath = path.join(fixture, `fixture.${kind}`);
      if (kind === 'zip') await fs.writeFile(archivePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
      else await createTar({ cwd: input, file: archivePath, portable: true, noMtime: true }, names);
      const destDir = path.join(fixture, 'output');
      const measure = async implementation => {
        await fs.mkdir(destDir);
        const start = performance.now();
        await implementation.extractArchive({ archivePath, destDir, kind, timeoutMs: 120000, durable: false });
        const elapsed = performance.now() - start;
        if ((await fs.readdir(path.join(destDir, nested))).length !== 500) throw new Error('incomplete output');
        await fs.rm(destDir, { recursive: true });
        return elapsed;
      };
      for (const mode of (process.env.ARCHIVE_MODES ?? 'off,require').split(',')) {
        baseline.configureFsSafeNative({ mode }); candidate.configureFsSafeNative({ mode });
        for (let i = 0; i < 3; i++) { await measure(baseline); await measure(candidate); }
        const observations = [];
        for (let i = 0; i < pairs; i++) {
          let a, b;
          if (i % 2) { b = await measure(candidate); a = await measure(baseline); }
          else { a = await measure(baseline); b = await measure(candidate); }
          const a1 = await measure(baseline), a2 = await measure(baseline);
          observations.push({ a, b, a1, a2 });
        }
        console.log(JSON.stringify({ kind, depth, mode, pairs, files: 500, bytesPerFile: 1024,
          baselineMs: median(observations.map(p => p.a)), candidateMs: median(observations.map(p => p.b)),
          pairedRatio: median(observations.map(p => p.b / p.a)), controlRatio: median(observations.map(p => p.a2 / p.a1)),
          observations }));
      }
    }
  }
} finally { await fs.rm(base, { recursive: true, force: true }); }
