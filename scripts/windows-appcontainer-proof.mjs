// Run after pnpm build and pnpm native:build on real Windows x64/ARM64.
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
fs.mkdirSync(output, { recursive: true });
try {
  fs.cpSync(path.join(repo, 'dist'), path.join(root, 'pkg/dist'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(root, 'pkg/package.json'));
  fs.cpSync(path.join(repo, 'packages', target), path.join(root, 'pkg/node_modules/@openclaw', `fs-safe-${target}`), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(root, 'node.exe'));
  fs.copyFileSync(path.join(repo, 'test/fixtures/windows-appcontainer-child.mjs'), path.join(root, 'child.mjs'));
  fs.writeFileSync(path.join(root, 'profiles.json'), '[]');
  for (const mode of ['require', 'off']) {
    execFileSync(path.join(root, 'node.exe'), [path.join(root, 'child.mjs'), 'ordinary', mode], { stdio: 'inherit', timeout: 120_000 });
  }
  const ps = value => `'${value.replaceAll("'", "''")}'`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -Path ${ps(path.join(repo, 'test/fixtures/windows-appcontainer.cs'))}; [AppContainerFixture]::AssertBaseline(${ps(root)}); [AppContainerFixture]::Run(${ps(root)})`],
  { stdio: 'inherit', timeout: 480_000 });
  const { configureFsSafeNative } = await import(pathToFileURL(path.join(root, 'pkg/dist/native-config.js')));
  const { inspectWindowsAcl } = await import(pathToFileURL(path.join(root, 'pkg/dist/advanced.js')));
  // The same Windows user outside either container must see its ACE as foreign.
  for (const mode of ['require', 'off']) {
    configureFsSafeNative({ mode });
    const acl = await inspectWindowsAcl(path.join(root, `${mode}-main`));
    assert.equal(acl.ok, true);
    assert.equal(acl.untrustedGroup.length, 1);
  }
  const rows = fs.readdirSync(root).filter(name => /^(ordinary|create|reopen|deny)-.*\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
  assert.equal(rows.length, 8);
  assert(rows.every(row => row.ok));
  fs.writeFileSync(path.join(output, `windows-${process.arch}.json`), JSON.stringify({ platform: process.platform, arch: process.arch, version: process.version, rows }, null, 2));
  console.log(JSON.stringify({ appcontainer: 'passed', arch: process.arch, scenarios: rows.length, threads: 2 }));
} catch (error) {
  for (const name of fs.readdirSync(root).filter(name => /^(ordinary|create|reopen|deny)-.*\.json$/.test(name))) {
    console.error(name, fs.readFileSync(path.join(root, name), 'utf8'));
  }
  throw error;
} finally {
  for (const name of fs.readdirSync(root).filter(name => /\.json$/.test(name))) {
    if (name !== 'profiles.json') fs.copyFileSync(path.join(root, name), path.join(output, `${process.arch}-${name}`));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
