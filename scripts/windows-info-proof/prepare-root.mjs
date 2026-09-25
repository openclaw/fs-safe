// Explicit proof-only types/assets/pack assembly. Ordinary prepack also rebuilds WASM.
// Its compiler selection, asset copier and npm result normalizer remain authoritative.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { archive, expectedCommonRootMembers, memberFacts, hash } from './artifacts.mjs';

const contract = JSON.parse(fs.readFileSync(new URL('./contract.json', import.meta.url), 'utf8'));
const [sourceArgument, candidateArgument, outputArgument] = process.argv.slice(2);
const source = fs.realpathSync.native(sourceArgument);
const candidate = fs.realpathSync.native(candidateArgument);
const output = path.resolve(outputArgument);
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(process.version, contract.nodeVersion);
assert.equal(process.env.GITHUB_REPOSITORY, 'openclaw/fs-safe');
assert.match(process.env.GITHUB_RUN_ID, /^[1-9][0-9]*$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/);
assert.match(process.env.PAIR_HARNESS_SHA, /^[0-9a-f]{40}$/);
assert.equal(process.env.PAIR_HARNESS_SHA, process.env.PAIR_EXPECTED_HARNESS_SHA);
assert.ok(!fs.existsSync(output)); fs.mkdirSync(output, { recursive: true });
const logRoot = path.join(path.dirname(output), 'preparation-data');
assert.ok(!fs.existsSync(logRoot)); fs.mkdirSync(logRoot);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).trim();
function snapshot(cwd, expected) {
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), expected.commit);
  assert.equal(git(cwd, ['rev-parse', 'HEAD^{tree}']), expected.tree);
  assert.equal(git(cwd, ['diff', '--name-only', 'HEAD', '--']), '');
  const entries = git(cwd, ['ls-tree', '-r', 'HEAD']).split('\n');
  const records = {};
  for (const row of entries) {
    const match = /^([0-9]{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(row); assert.ok(match, row);
    const [, mode, blob, name] = match; const data = fs.readFileSync(path.join(cwd, name));
    assert.equal(createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex'), blob, name);
    records[name] = { mode, blob, sha256: hash(data) };
  }
  return { ...expected, files: records };
}
async function download(url, cap, filename) {
  const response = await fetch(url, { signal: AbortSignal.timeout(contract.caps.publicDataDownloadSeconds * 1000) });
  assert.equal(response.status, 200, url);
  if (response.headers.has('content-length')) assert.ok(Number(response.headers.get('content-length')) <= cap);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; assert.ok(length <= cap); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks, length); fs.writeFileSync(path.join(logRoot, filename), bytes, { flag: 'wx' });
  return bytes;
}
const baselineBefore = snapshot(source, contract.baseline);
const candidateBefore = snapshot(candidate, contract.candidate);
fs.writeFileSync(path.join(logRoot, 'source-before.json'), JSON.stringify({ baseline: baselineBefore, candidate: candidateBefore }, null, 2) + '\n', { flag: 'wx' });
assert.deepEqual(Object.keys(baselineBefore.files), Object.keys(candidateBefore.files));
assert.deepEqual(Object.keys(baselineBefore.files).filter(name => baselineBefore.files[name].blob !== candidateBefore.files[name].blob), contract.changedFiles);
const release = contract.publishedWasm.releaseCommit;
assert.equal(git(source, ['rev-parse', `${contract.publishedWasm.releaseTag}^{}`]), release);
assert.equal(git(source, ['diff', '--name-only', release, contract.baseline.commit, '--', ...contract.wasmInputScopes]), '');
const sourceInputs = git(source, ['ls-tree', '-r', release, '--', ...contract.wasmInputScopes]);
assert.equal(sourceInputs, git(source, ['ls-tree', '-r', contract.baseline.commit, '--', ...contract.wasmInputScopes]));
fs.writeFileSync(path.join(logRoot, 'wasm-source-inputs.json'), JSON.stringify({ release, baseline: contract.baseline, scopes: contract.wasmInputScopes, identicalGitTreeRows: sourceInputs.split('\n') }, null, 2) + '\n', { flag: 'wx' });
const publicMetadataBytes = await download(contract.publishedWasm.registryMetadataUrl, contract.caps.maxPublicMetadataBytes, 'npm-metadata.json');
const publicMetadata = JSON.parse(publicMetadataBytes);
assert.equal(publicMetadata.name, '@openclaw/fs-safe'); assert.equal(publicMetadata.version, '0.19.0');
assert.equal(publicMetadata.dist.tarball, contract.publishedWasm.tarUrl);
const publicTarBytes = await download(contract.publishedWasm.tarUrl, contract.caps.maxRootArchiveBytes, 'published-root-data.tgz');
assert.equal(hash(publicTarBytes), contract.publishedWasm.tarSha256);
const publicSha512 = createHash('sha512').update(publicTarBytes).digest('hex');
assert.equal(publicMetadata.dist.integrity, 'sha512-' + Buffer.from(publicSha512, 'hex').toString('base64'));
const attestationBytes = await download(contract.publishedWasm.registryAttestationsUrl, contract.caps.maxPublicMetadataBytes, 'npm-attestations.json');
const attestation = JSON.parse(attestationBytes).attestations.find(row => row.predicateType === 'https://slsa.dev/provenance/v1');
assert.ok(attestation?.bundle?.dsseEnvelope?.payload);
const provenance = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64'));
assert.equal(provenance.predicateType, 'https://slsa.dev/provenance/v1');
assert.ok(provenance.subject.some(row => row.name === 'pkg:npm/%40openclaw/fs-safe@0.19.0' && row.digest.sha512 === publicSha512));
assert.deepEqual(provenance.predicate.buildDefinition.externalParameters.workflow, {
  ref: 'refs/tags/v0.19.0', repository: 'https://github.com/openclaw/fs-safe', path: contract.publishedWasm.releaseWorkflow,
});
assert.ok(provenance.predicate.buildDefinition.resolvedDependencies.some(row => row.digest?.gitCommit === release));
assert.equal(provenance.predicate.runDetails.metadata.invocationId, contract.publishedWasm.releaseInvocation);
const publicArchive = archive(path.join(logRoot, 'published-root-data.tgz'), true);
const selected = publicArchive.members[contract.publishedWasm.member];
assert.ok(selected); assert.equal(selected.sha256, contract.publishedWasm.sha256);
assert.equal(selected.bytes, contract.publishedWasm.bytes); assert.equal(selected.mode, 0o755);
assert.deepEqual(selected.content.subarray(0, 8), Buffer.from([0,97,115,109,1,0,0,0]));
// No other member of the published package is extracted, imported or executed.
assert.ok(!fs.existsSync(path.join(source, 'dist')));
const require = createRequire(path.join(source, 'package.json'));
const packageFile = require.resolve('typescript/package.json');
const compilerPackage = JSON.parse(fs.readFileSync(packageFile));
assert.equal(compilerPackage.version, '7.0.2'); assert.equal(typeof compilerPackage.bin.tsc, 'string');
const compiler = path.resolve(path.dirname(packageFile), compilerPackage.bin.tsc);
execFileSync(process.execPath, [compiler, '-p', 'tsconfig.json'], {
  cwd: source, timeout: contract.caps.typescriptSeconds * 1000, maxBuffer: contract.caps.maxStepLogBytes, stdio: ['ignore', 'pipe', 'pipe'],
});
process.chdir(source);
const { copyWindowsCommandAssets } = await import(pathToFileURL(path.join(source, 'scripts/windows-command-assets.mjs')));
copyWindowsCommandAssets();
const wasmPath = path.join(source, 'dist/archive-parser.wasm');
fs.writeFileSync(wasmPath, selected.content, { flag: 'wx', mode: selected.mode }); fs.chmodSync(wasmPath, selected.mode);
assert.equal(fs.statSync(wasmPath).mode & 0o7777, selected.mode);
const { normalizePackResult } = await import(pathToFileURL(path.join(source, 'scripts/npm-pack-result.mjs')));
const packEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')));
const rawPack = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], {
  cwd: source, env: packEnvironment, encoding: 'utf8', timeout: contract.caps.packSeconds * 1000, maxBuffer: contract.caps.maxStepLogBytes,
});
const packed = normalizePackResult(JSON.parse(rawPack), '@openclaw/fs-safe'); assert.equal(path.basename(packed.filename), packed.filename);
const assembledPath = path.join(output, 'openclaw-fs-safe-common-root.tgz'); fs.renameSync(path.join(output, packed.filename), assembledPath);
const assembled = archive(assembledPath, true); const actualMembers = memberFacts(assembled);
assert.deepEqual(actualMembers, expectedCommonRootMembers(), 'fresh root differs from pinned baseline bfc2749 reference inventory');
assert.ok(!Object.keys(actualMembers).some(name => name.endsWith('.node')));
assert.deepEqual(snapshot(source, contract.baseline), baselineBefore);
assert.deepEqual(snapshot(candidate, contract.candidate), candidateBefore);
const manifest = {
  schema: 2, sha256: assembled.sha256, bytes: assembled.bytes, source: contract.baseline,
  originalBaselineRootSha256: contract.originalBaselineRootSha256,
  wasm: { ...contract.publishedWasm, origin: 'published 0.19.0 WASM member only; no compiler-execution equivalence claim' },
  origin: 'fresh Linux CI baseline bfc2749 TypeScript/declarations/assets assembly with pinned published WASM; no native or WASM rebuild',
  members: actualMembers,
};
const manifestPath = path.join(output, 'common-root-manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
const proof = {
  schema: 2, repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  harnessSha: process.env.PAIR_HARNESS_SHA, source: contract.baseline, candidate: contract.candidate,
  originalBaselineRootSha256: contract.originalBaselineRootSha256, originalBaselineRelabeled: false,
  commonRootSha256: assembled.sha256, manifestSha256: hash(fs.readFileSync(manifestPath)),
  wasmSourceInputs: { scopes: contract.wasmInputScopes, identicalGitTreeRows: sourceInputs.split('\n'), sourceCorrespondenceOnly: true },
  releaseProvenance: { registryTarSha256: hash(publicTarBytes), registryTarSha512: publicSha512, metadataSha256: hash(publicMetadataBytes), attestationSha256: hash(attestationBytes), payload: provenance, signatureVerifierExecuted: false },
  compiler: { version: compilerPackage.version, packageSha256: hash(fs.readFileSync(packageFile)), executableSha256: hash(fs.readFileSync(compiler)), nodeVersion: process.version, nodeSha256: hash(fs.readFileSync(process.execPath)), arguments: ['-p','tsconfig.json'] },
  pack: { npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(), arguments: ['pack','--json','--ignore-scripts','--pack-destination','<output>'] },
  sourceInventories: { baseline: baselineBefore, candidate: candidateBefore },
  matchingMembersExceptPublishedWasm: true, tarModesMatched: true, nativeAddonMembers: 0, wasmRebuilt: false, nativeRebuilt: false, productExecuted: false,
};
const proofPath = path.join(output, 'preparation-proof.json'); fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
assert.deepEqual(fs.readdirSync(output).sort(), ['common-root-manifest.json','openclaw-fs-safe-common-root.tgz','preparation-proof.json']);
assert.ok(fs.readdirSync(output).reduce((n, f) => n + fs.statSync(path.join(output, f)).size, 0) <= contract.caps.maxPreparationArtifactBytes);
for (const [key, value] of Object.entries({ root_sha256: assembled.sha256, manifest_sha256: proof.manifestSha256, proof_sha256: hash(fs.readFileSync(proofPath)) })) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
console.log(JSON.stringify({ prepared: true, rootSha256: assembled.sha256, originalBaselineRootSha256: contract.originalBaselineRootSha256, wasmSha256: selected.sha256, members: Object.keys(actualMembers).length, wasmRebuilt: false, productExecuted: false }));
