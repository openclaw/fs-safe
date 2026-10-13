// Run after pnpm build and pnpm native:build on an elevated Windows x64/ARM64
// runner. Elevation grants/restores ancestor metadata access for Node startup;
// the proof children themselves run with restricted AppContainer tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
assert.equal(process.platform, 'win32');
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-safe-appcontainer-'));
const target = `win32-${process.arch}-msvc`;
const output = path.join(repo, 'artifacts-appcontainer');
const diagnosticsOnly = process.argv.includes('--diagnostics-only');
fs.mkdirSync(output, { recursive: true });
try {
  if (!diagnosticsOnly) {
    fs.cpSync(path.join(repo, 'dist'), path.join(root, 'pkg/dist'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(root, 'pkg/package.json'));
    fs.cpSync(path.join(repo, 'packages', target), path.join(root, 'pkg/node_modules/@openclaw', `fs-safe-${target}`), { recursive: true });
  }
  fs.copyFileSync(process.execPath, path.join(root, 'node.exe'));
  fs.copyFileSync(path.join(repo, 'test/fixtures/windows-appcontainer-child.mjs'), path.join(root, 'child.mjs'));
  fs.copyFileSync(path.join(repo, 'test/fixtures/windows-appcontainer-canonicalization.mjs'), path.join(root, 'canonicalization.mjs'));
  fs.writeFileSync(path.join(root, 'profiles.json'), '[]');
  fs.writeFileSync(path.join(root, 'canonical-expected.json'), JSON.stringify(fs.realpathSync.native(root)));
  for (const mode of diagnosticsOnly ? [] : ['require', 'off']) {
    execFileSync(path.join(root, 'node.exe'), [path.join(root, 'child.mjs'), 'ordinary', mode], { stdio: 'inherit', timeout: 120_000 });
  }
  const ps = value => `'${value.replaceAll("'", "''")}'`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; & (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') /nologo /target:exe ${ps(`/out:${path.join(root, 'canonicalization.exe')}`)} ${ps(path.join(repo, 'test/fixtures/windows-appcontainer.cs'))}; if ($LASTEXITCODE -ne 0) { throw 'Diagnostic fixture compilation failed' }; [System.Reflection.Assembly]::LoadFrom(${ps(path.join(root, 'canonicalization.exe'))}) | Out-Null; ${diagnosticsOnly ? '' : `[AppContainerFixture]::AssertBaseline(${ps(root)}); `}[AppContainerFixture]::Run(${ps(root)}, $${diagnosticsOnly})`],
  { stdio: 'inherit', timeout: 480_000 });
  for (const name of ['diagnostic-node.json', 'diagnostic-native.json']) {
    console.log(name, fs.readFileSync(path.join(root, name), 'utf8'));
  }
  if (!diagnosticsOnly) {
    // Loading the fixture's addon here would pin its DLL until this parent exits,
    // preventing cleanup on Windows. Children use the isolated identical copy.
    const { configureFsSafeNative } = await import(pathToFileURL(path.join(repo, 'dist/native-config.js')));
    const { inspectWindowsAcl } = await import(pathToFileURL(path.join(repo, 'dist/advanced.js')));
    // The same Windows user outside either container must see its ACE as foreign.
    for (const mode of ['require', 'off']) {
      configureFsSafeNative({ mode });
      const acl = await inspectWindowsAcl(path.join(root, 'require-main'));
      assert.equal(acl.ok, true);
      assert.equal(acl.untrustedGroup.length, 1);
    }
    const rows = fs.readdirSync(root).filter(name => /^(ordinary|create|reopen|deny|native-off)-.*\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
    assert.equal(rows.length, 6);
    assert(rows.every(row => row.ok));
    for (const row of rows) for (const entry of row.canonicalPaths ?? []) {
      assert.equal(entry.canonical, fs.realpathSync.native(entry.path));
      configureFsSafeNative({ mode: 'off' });
      const compatibility = await inspectWindowsAcl(entry.path);
      assert.equal(compatibility.ok, true);
      assert.deepEqual(entry.entries, compatibility.entries);
    }
    fs.writeFileSync(path.join(output, `windows-${process.arch}.json`), JSON.stringify({ platform: process.platform, arch: process.arch, version: process.version, rows }, null, 2));
    console.log(JSON.stringify({ appcontainer: 'passed', arch: process.arch, scenarios: rows.length, threads: 2 }));
  }
} catch (error) {
  console.error(error);
  for (const name of fs.readdirSync(root).filter(name => name.startsWith('progress-'))) {
    console.error(name, fs.readFileSync(path.join(root, name), 'utf8'));
  }
  for (const name of fs.readdirSync(root).filter(name => /^(ordinary|create|reopen|deny|native-off|diagnostic)-.*\.json$/.test(name))) {
    console.error(name, fs.readFileSync(path.join(root, name), 'utf8'));
  }
  throw error;
} finally {
  for (const name of fs.readdirSync(root).filter(name => /\.jsonl?$/.test(name))) {
    if (name !== 'profiles.json') fs.copyFileSync(path.join(root, name), path.join(output, `${process.arch}-${name}`));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
