import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
const contract = JSON.parse(fs.readFileSync(new URL('./contract.json', import.meta.url), 'utf8'));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const octal = bytes => { const s = bytes.toString('ascii').replace(/\0.*$/s, '').trim(); assert.match(s, /^[0-7]+$/); return Number.parseInt(s, 8); };
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.max(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0))));
export function archive(file, root) {
  const stat = fs.statSync(file);
  assert.ok(stat.size <= (root ? contract.caps.maxRootArchiveBytes : contract.caps.maxNativeArchiveBytes));
  const compressed = fs.readFileSync(file);
  const limit = root ? contract.caps.maxRootExpandedBytes : contract.caps.maxNativeExpandedBytes;
  const data = gunzipSync(compressed, { maxOutputLength: limit + 1024 * 1024 });
  const members = {}; let offset = 0; let expanded = 0;
  while (offset + 512 <= data.length && !data.subarray(offset, offset + 512).every(byte => byte === 0)) {
    const header = data.subarray(offset, offset + 512);
    const checksum = octal(header.subarray(148, 156));
    assert.equal(header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0), checksum);
    const prefix = text(header.subarray(345, 500));
    const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
    assert.ok(name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..'));
    assert.ok(!Object.hasOwn(members, name), `duplicate tar member ${name}`);
    assert.ok(header[156] === 0 || header[156] === 48, 'only regular archive members allowed');
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    assert.ok(size <= (root ? contract.caps.maxRootMemberBytes : contract.caps.maxNativeExpandedBytes));
    const bytes = data.subarray(offset + 512, offset + 512 + size); assert.equal(bytes.length, size);
    expanded += size; assert.ok(expanded <= limit);
    members[name] = { bytes: size, mode, sha256: hash(bytes), content: bytes };
    assert.ok(Object.keys(members).length <= (root ? contract.caps.maxRootMembers : contract.caps.maxNativeMembers));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(data.length - offset >= 1024 && data.subarray(offset).every(byte => byte === 0), 'tar tail malformed');
  return { sha256: hash(compressed), bytes: compressed.length, expanded, members };
}
function pe(file) {
  const bytes = fs.readFileSync(file); assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  const start = bytes.readUInt32LE(0x3c); assert.equal(bytes.readUInt32LE(start), 0x4550);
  assert.equal(bytes.readUInt16LE(start + 4), 0x8664);
  const count = bytes.readUInt16LE(start + 6); const optionalSize = bytes.readUInt16LE(start + 20);
  assert.equal(bytes.readUInt16LE(start + 24), 0x20b); assert.ok(count > 0 && count <= 32);
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = start + 24 + optionalSize + i * 40;
    const name = text(bytes.subarray(at, at + 8)); const size = bytes.readUInt32LE(at + 16); const offset = bytes.readUInt32LE(at + 20);
    assert.ok(offset + size <= bytes.length);
    const flags = bytes.readUInt32LE(at + 36);
    sections.push({ name, rva: bytes.readUInt32LE(at + 12), rawOffset: offset, rawBytes: size, flags,
      executable: !!(flags & 0x20000000), sha256: hash(bytes.subarray(offset, offset + size)) });
  }
  return { sha256: hash(bytes), bytes: bytes.length, machine: 'AMD64', sections };
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
export function expectedCommonRootMembers() {
  const baseline = JSON.parse(fs.readFileSync(new URL('./baseline-root.json', import.meta.url), 'utf8'));
  assert.equal(baseline.sha256, contract.originalBaselineRootSha256);
  const expected = structuredClone(baseline.members);
  expected[contract.publishedWasm.member] = {
    bytes: contract.publishedWasm.bytes, mode: contract.publishedWasm.mode, sha256: contract.publishedWasm.sha256,
  };
  return expected;
}
export function memberFacts(record) {
  return Object.fromEntries(Object.entries(record.members).map(([name, { content, ...row }]) => [name, row]));
}

function main() {
const [mode, ...args] = process.argv.slice(2);
if (mode === 'root') {
  const [file, manifestFile, expectedRootHash, expectedManifestHash, output] = args;
  assert.match(expectedRootHash, /^[0-9a-f]{64}$/); assert.match(expectedManifestHash, /^[0-9a-f]{64}$/);
  const manifestBytes = fs.readFileSync(manifestFile); assert.equal(hash(manifestBytes), expectedManifestHash);
  const manifest = JSON.parse(manifestBytes);
  const record = archive(file, true);
  assert.equal(record.sha256, expectedRootHash); assert.equal(record.sha256, manifest.sha256);
  assert.equal(record.bytes, manifest.bytes);
  assert.equal(manifest.source.commit, contract.baseline.commit); assert.equal(manifest.source.tree, contract.baseline.tree);
  assert.equal(manifest.originalBaselineRootSha256, contract.originalBaselineRootSha256);
  assert.equal(manifest.wasm.sha256, contract.publishedWasm.sha256); assert.equal(manifest.wasm.mode, 0o755);
  assert.deepEqual(memberFacts(record), expectedCommonRootMembers()); assert.deepEqual(manifest.members, expectedCommonRootMembers());
  assert.ok(!Object.keys(record.members).some(name => name.endsWith('.node')));
  write(output, { ...manifest, verifiedByteAndModeExact: true, nativeAddonMembers: 0 });
} else if (mode === 'native') {
  const [file, binary, declaration, output] = args; const record = archive(file, false);
  assert.deepEqual(Object.keys(record.members).sort(), ['package/fs-safe-native.node', 'package/package.json']);
  const pkg = JSON.parse(record.members['package/package.json'].content);
  assert.equal(pkg.name, '@openclaw/fs-safe-win32-x64-msvc'); assert.equal(pkg.version, '0.19.0');
  assert.deepEqual(pkg.os, ['win32']); assert.deepEqual(pkg.cpu, ['x64']); assert.equal(pkg.main, 'fs-safe-native.node');
  assert.equal(record.members['package/fs-safe-native.node'].sha256, hash(fs.readFileSync(binary)));
  write(output, { archiveSha256: record.sha256, archiveBytes: record.bytes, package: pkg,
    binary: pe(binary), declarationsSha256: hash(fs.readFileSync(declaration)) });
} else if (mode === 'compare') {
  const [directory] = args;
  const records = {};
  for (const role of contract.roles) records[role] = JSON.parse(fs.readFileSync(path.join(directory, `${role}-native-manifest.json`)));
  assert.equal(records.baseline.declarationsSha256, records.candidate.declarationsSha256);
  const commonRoot = JSON.parse(fs.readFileSync(path.join(directory, 'root-input.json')));
  const toolchain = JSON.parse(fs.readFileSync(path.join(directory, 'toolchain.json')));
  const reports = [];
  for (const role of contract.roles) for (const runtime of contract.runtimes) for (const filesystem of contract.filesystems) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, `${role}-${runtime}-${filesystem}.json`)));
    assert.equal(report.role, role); assert.equal(report.runtime, runtime); assert.equal(report.filesystem, filesystem);
    assert.equal(report.runtimeSha256, toolchain.files[runtime].sha256);
    assert.equal(report.runtimeVersion, runtime === 'bun' ? contract.bunVersion : contract.nodeVersion);
    assert.equal(report.ok, true); assert.equal(report.timed, false); assert.deepEqual(report.cleanupFailures, []);
    assert.equal(report.borrowedAndNativeDescriptorsSettled, true);
    assert.equal(report.installedRootMembersVerified, 587);
    assert.equal(report.nativeSha256, records[role].binary.sha256); assert.equal(report.rootPackageSha256, commonRoot.sha256);
    const expected = [...contract.commonCases, ...(filesystem === 'ReFS' ? contract.refsCases : contract.ntfsCases)];
    assert.deepEqual(report.cases.map(row => row.id), expected);
    assert.ok(report.cases.every(row => row.status === 'pass'));
    assert.ok(report.nativeCalls.length > 0 && report.nativeCalls.length <= contract.caps.maxNativeCallsPerLane);
    if (filesystem === 'ReFS') {
      assert.equal(report.fixtureHelpers, 3);
      const extents = report.fixtureObservations.filter(row => row.action === 'extent');
      assert.equal(extents.length, 2); assert.equal(extents[0].lcn, extents[1].lcn);
      assert.ok(extents.every(row => row.allocatedBytes <= contract.caps.maxSparseFileAllocatedBytes));
      assert.ok(extents.reduce((n, row) => n + row.allocatedBytes, 0) <= contract.caps.maxFixtureAllocatedBytes);
    } else assert.equal(report.fixtureHelpers, 0);
    reports.push(report);
  }
  assert.equal(reports.length, contract.laneCount); assert.equal(reports.reduce((n, r) => n + r.cases.length, 0), contract.caseCount);
  for (const runtime of contract.runtimes) for (const filesystem of contract.filesystems) {
    const pair = contract.roles.map(role => reports.find(r => r.role === role && r.runtime === runtime && r.filesystem === filesystem));
    assert.deepEqual(pair[0].cases, pair[1].cases, `${runtime}/${filesystem} results differ`);
    assert.equal(pair[0].runtimeSha256, pair[1].runtimeSha256);
  }
  const executableSections = contract.roles.map(role => records[role].binary.sections.filter(s => s.executable));
  write(path.join(directory, 'comparison.json'), { installedLanes: reports.length, cases: contract.caseCount,
    declarationsIdentical: true, installedContractsPass: true, timed: false,
    fullBinaryIdentical: records.baseline.binary.sha256 === records.candidate.binary.sha256,
    executableSections, codegenDecision: records.baseline.binary.sha256 === records.candidate.binary.sha256 ? 'BYTE_IDENTICAL' : 'PARENT_CODEGEN_REVIEW_REQUIRED',
    performanceAcceptance: false, heldStudyCredit: false });
} else throw new Error('Unknown artifact verification mode');

}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
