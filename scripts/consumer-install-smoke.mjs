import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { consumerFixtureArtifacts } from "./consumer-fixture-artifacts.mjs";
import { startConsumerRegistry } from "./consumer-registry.mjs";
import { hostNativeTarget, nativePackageDirectory, nativeTargets } from "./native-targets.mjs";

const exec = promisify(execFile);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const suffixCompiledModules = [
  "advanced.js", "byte-budget.js", "config.js", "device-path.js", "directory-guard.js",
  "durability.js", "errors.js", "file-hash.js", "file-identity.js", "file-observation.js",
  "local-file-access.js", "native-config.js", "native.js", "path-suffix-aliases.js", "path.js",
  "read-open-flags.js", "realpath.js", "root-errors.js", "safe-path-segment.js",
  "strict-file-identity.js", "string-coerce.js",
];
const suffixScenarios = [
  "identical-no-predicate",
  "lookup-ascii",
  "lookup-raw-nfc-nfd",
  "lookup-non-ascii-case",
  "lookup-nested",
  "policy-exclusion-after-creation",
  "exact-thrown-sentinel",
  "relative-directory-anchored-before-getter-chdir",
  "invalid-and-over-limit-no-mutation",
  "deterministic-collision-exhaustion",
  "callback-replaces-owned-ancestor",
  "callback-makes-owned-directory-nonempty",
];
const portableScenarios = [
  "root-no-clobber-move", "standalone-no-clobber-publication",
  "staged-publication-and-cleanup", "staged-parent-drift", "copy-and-clone-metadata",
  "temp-cleanup-mechanism", "tar-bzip2", "tar-zstd", "zip", "windows-security",
];
const portableCompiledModules = [
  "root-impl.js", "root-move-noreplace.js", "root-move-portable.js", "publish-file.js",
  "root-move-command.js", "darwin-move-command.js", "linux-rename-command.js", "windows-move-command.js", "windows-move-source.js",
  "publish-file-move.js", "publish-file-failure.js", "portable-source-retirement.js", "file-hash.js",
  "windows-source-retirement.js", "windows-source-retirement-source.js",
  "native-staged-file.js", "node-staged-file.js", "sibling-rename-command.js", "copy.js", "copy-file-input.js",
  "clone-metadata.js", "private-temp-workspace.js", "temp-workspace-owner.js", "temp-target.js",
  "archive.js", "archive-kind.js", "archive-read.js", "archive-tar-stream.js",
  "archive-codec-wasm.js", "archive-parser.wasm", "native.js", "native-fallback-warning.js",
  "private-directory.js", "owner-dacl.js", "secure-file.js", "secure-file-windows.js",
  "windows-security-command.js", "windows-security-source.js",
];

export function isolatedConsumerEnv(directory) {
  mkdirSync(directory, { recursive: true });
  const env = {};
  // Do not inherit auth, NODE_PATH/NODE_OPTIONS, registry, workspace, or proxy config.
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP"]) {
    env[key] = directory;
  }
  for (const key of ["userconfig", "globalconfig"]) {
    const file = join(directory, `${key}.npmrc`);
    writeFileSync(file, "");
    env[`npm_config_${key}`] = file;
  }
  env.npm_config_cache = join(directory, "npm-cache");
  env.npm_config_update_notifier = "false";
  // Disposable consumers cannot reuse the compile cache; avoid its exit-time I/O.
  env.NODE_DISABLE_COMPILE_CACHE = "1";
  env.CI = "true";
  return env;
}

async function run(command, args, cwd, env) {
  // Async children leave the test-owned registry's event loop available.
  const { stdout } = await exec(command[0], [...command.slice(1), ...args], {
    cwd, env, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function isNativeExecutable(file) {
  const descriptor = openSync(file, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    // ELF, Mach-O (including universal binaries), and Windows PE executables.
    return header.readUInt16BE(0) === 0x4d5a || [
      0x7f454c46, 0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
      0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
    ].includes(header.readUInt32BE(0));
  } finally {
    closeSync(descriptor);
  }
}

/** @returns {[string, ...string[]]} */
export function resolvePnpmCommand(cli = process.env.npm_execpath) {
  const resolved = cli && isAbsolute(cli) && statSync(cli, { throwIfNoEntry: false })?.isFile()
    ? realpathSync(cli) : undefined;
  if (resolved && /^pnpm\.(?:c?js|mjs)$/.test(basename(resolved))) return [process.execPath, resolved];
  // @pnpm/exe supplies a standalone binary, not a script for the current Node.
  // Keep shell/cmd shims rejected and never substitute a different pnpm from PATH.
  if (resolved && /^pnpm(?:\.exe)?$/.test(basename(resolved)) && isNativeExecutable(resolved)) return [resolved];
  throw new Error("package collection requires a pnpm lifecycle CLI; run pnpm package:collect or pnpm package:smoke");
}

const hashScript = `
  import assert from 'node:assert/strict';
  import { configureFsSafeNative } from '@openclaw/fs-safe';
  import { sha256File } from '@openclaw/fs-safe/durability';
  configureFsSafeNative({mode:process.argv[1]});
  if(process.argv[2]==='missing') {
    await assert.rejects(sha256File('fixture.txt'), {code:'helper-unavailable'});
    console.log('helper-unavailable');
  } else {
    const result=await sha256File('fixture.txt', {maxBytes:3, signal:new AbortController().signal});
    assert.equal(result.bytes,3);
    await assert.rejects(sha256File('fixture.txt', {maxBytes:2}), {code:'too-large'});
    const reason=new Error('cancelled consumer hash');
    await assert.rejects(sha256File('fixture.txt', {signal:AbortSignal.abort(reason)}), error=>error===reason);
    assert.equal(result.digest,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    console.log(result.digest);
  }
`;

export async function consumerInstallSmoke({ rootPkg, manifest, outputDir, npmCli, pnpmCommand, allowHostOnly, source }) {
  const temporary = mkdtempSync(join(tmpdir(), "fs-safe-consumer-proof-"));
  let server;
  try {
    const fixtureDir = join(temporary, "registry-artifacts");
    mkdirSync(fixtureDir);
    const packingEnv = isolatedConsumerEnv(join(temporary, "packing-config"));
    const { artifacts, synthetic } = await consumerFixtureArtifacts({
      rootPkg, manifest, outputDir, fixtureDir, allowHostOnly,
      runNpm: (args, cwd) => run([process.execPath, npmCli], args, cwd, packingEnv),
    });
    server = await startConsumerRegistry(artifacts);
    // Check every platform metadata/tarball endpoint, including foreign fixtures,
    // before an optional install can hide a missing package behind a successful exit.
    for (const target of nativeTargets) {
      const response = await fetch(`${server.registry}/${encodeURIComponent(target.package)}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      const pkg = (await response.json()).versions[rootPkg.version];
      const expected = artifacts.find((artifact) => artifact.pkg.name === target.package).pkg;
      const { dist, ...metadata } = pkg;
      assert.deepEqual(metadata, expected);
      const tarball = await fetch(dist.tarball, { signal: AbortSignal.timeout(10_000) });
      assert.equal(tarball.status, 200);
      const bytes = Buffer.from(await tarball.arrayBuffer());
      assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, dist.integrity);
    }
    const host = hostNativeTarget();
    const expectedSourceCommit = process.env.FS_SAFE_EXPECTED_SOURCE_COMMIT;
    if (expectedSourceCommit) {
      assert.match(expectedSourceCommit, /^[0-9a-f]{40}$/i);
      assert.equal(source.commit, expectedSourceCommit);
      assert.match(source.tree, /^[0-9a-f]{40}$/i);
      assert.equal(source.dirty, false);
    }
    const rootArtifact = artifacts.find((artifact) => artifact.pkg.name === rootPkg.name);
    assert.ok(rootArtifact?.integrity);
    const suffixProbeSource = readFileSync(new URL("./consumer-suffix-probe.mjs", import.meta.url));
    const portableProbeSource = readFileSync(new URL("./consumer-portable-probe.mjs", import.meta.url));
    const portableProbeHash = createHash("sha256").update(portableProbeSource).digest("hex");
    const portableModuleHashes = Object.fromEntries(portableCompiledModules.map((name) => [name, sha256(join("dist", name))]));
    const metadataHelperSource = readFileSync(new URL("./consumer-proof-metadata.mjs", import.meta.url));
    const suffixExpected = {
      source,
      rootIntegrity: rootArtifact.integrity,
      suffixCompiledSha256: Object.fromEntries(suffixCompiledModules.map((name) => [name, sha256(join("dist", name))])),
      suffixProbeSha256: createHash("sha256").update(suffixProbeSource).digest("hex"),
      metadataHelperSha256: createHash("sha256").update(metadataHelperSource).digest("hex"),
      hostBinarySha256: sha256(fileURLToPath(new URL("fs-safe-native.node", nativePackageDirectory(host)))),
    };
    const proof = {
      host: host.label, node: process.version, source, expectedSourceCommit: expectedSourceCommit ?? null,
      root: manifest.find((artifact) => artifact.name === rootPkg.name),
      syntheticForeignPackages: synthetic, managers: [],
    };
    for (const [manager, command] of [["npm", [process.execPath, npmCli]], ["pnpm", pnpmCommand]]) {
      const managerProof = { manager, cases: [] };
      for (const omitted of [false, true]) {
        const directory = join(temporary, `${manager}-${omitted ? "omitted" : "normal"}`);
        mkdirSync(directory);
        const env = isolatedConsumerEnv(join(directory, "config"));
        env.npm_config_registry = server.registry;
        const version = await run(command, ["--version"], directory, env);
        if (manager === "pnpm") assert.equal(`pnpm@${version}`, rootPkg.packageManager);
        managerProof.version = version;
        writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
        const args = manager === "npm"
          ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...(omitted ? ["--omit=optional"] : [])]
          : ["add", "--ignore-scripts", "--ignore-workspace", "--store-dir", join(directory, "store"), ...(omitted ? ["--no-optional"] : [])];
        // The only requested package is the root; its exact optional pins are untouched.
        args.push(`${rootPkg.name}@${rootPkg.version}`, "--registry", server.registry);
        await run(command, args, directory, env);
        assert.deepEqual(Object.keys(readJson(join(directory, "package.json")).dependencies), [rootPkg.name]);
        const lockfile = readFileSync(join(directory, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"), "utf8");
        assert.ok(lockfile.includes(rootArtifact.integrity), "lockfile must pin the collected root tarball integrity");
        writeFileSync(join(directory, "expected.json"), JSON.stringify({
          rootPkg, host, omitted, platforms: nativeTargets.map((target) => target.package),
          entryHash: createHash("sha256").update(readFileSync("dist/index.js")).digest("hex"),
          portableProbeHash,
          portableModuleHashes,
          sidecarModuleHashes: Object.fromEntries([
            "config.js", "file-lock.js", "native-config.js", "root.js", "root-impl.js",
            "sidecar-lock.js", "sidecar-lock-acquire.js", "sidecar-lock-handle.js",
            "sidecar-lock-reclaim.js",
          ].map((name) => [
            name,
            createHash("sha256").update(readFileSync(join("dist", name))).digest("hex"),
          ])),
          sidecarProbeHash: createHash("sha256")
            .update(readFileSync(new URL("./consumer-sidecar-snapshot-probe.mjs", import.meta.url)))
            .digest("hex"),
          metadataHelperHash: createHash("sha256")
            .update(readFileSync(new URL("./consumer-proof-metadata.mjs", import.meta.url)))
            .digest("hex"),
          manager: { name: manager, version },
          ...suffixExpected,
        }));
        writeFileSync(join(directory, "probe.mjs"), readFileSync(new URL("./consumer-install-probe.mjs", import.meta.url)));
        await run([process.execPath, join(directory, "probe.mjs")], [], directory, env);
        const installed = readJson(join(directory, "installed.json"));
        writeFileSync(join(directory, "fixture.txt"), "abc");
        async function hash(mode, missing = false) {
          return run([process.execPath], ["--input-type=module", "--eval", hashScript, mode, missing ? "missing" : "present"], directory, env);
        }
        const cases = { omitted, nativePackages: installed.nativePackages };
        cases.require = await hash("require", omitted);
        cases.auto = await hash("auto");
        cases.off = await hash("off");
        if (omitted) {
          const portableProbe = join(directory, "portable-probe.mjs");
          writeFileSync(portableProbe, portableProbeSource);
          cases.portableNoNative = [];
          for (const mode of ["off", "auto"]) {
            const receipt = JSON.parse(await run([process.execPath, portableProbe], [mode], directory, env));
            assert.equal(receipt.mode, mode);
            assert.deepEqual(receipt.packageManager, { name: manager, version });
            assert.deepEqual(receipt.source, source);
            assert.deepEqual(receipt.package, { name: rootPkg.name, version: rootPkg.version, integrity: rootArtifact.integrity });
            assert.equal(receipt.probeSha256, portableProbeHash);
            assert.deepEqual(receipt.modules, portableModuleHashes);
            assert.deepEqual(receipt.nativePackages, []);
            assert.equal(receipt.nativeLoaded, false);
            assert.equal(receipt.importedSubpaths, Object.keys(rootPkg.exports).length - 1);
            assert.deepEqual(receipt.rows.map((row) => row.scenario), portableScenarios);
            if (process.platform !== "win32") {
              const moved = receipt.rows[0].modeZero;
              assert.equal(moved.mode, 0);
              assert.equal(moved.moves, 2);
              assert.equal(typeof moved.contentAccessDenied, "boolean");
              for (const field of ["identityPreserved", "modePreserved", "sourceConsumed", "collisionPreserved", "bytesVerifiedAfterFixtureModeRestore"]) {
                assert.equal(moved[field], true, `mode-zero move proof missing ${field}`);
              }
              if (process.geteuid?.() !== 0) assert.equal(moved.contentAccessDenied, true);
              if (process.platform === "darwin") {
                const atomicCommand = moved.contentAccessDenied ? 1 : 0;
                assert.deepEqual(receipt.moveWarnings, { ordinary: 1, atomicCommand, total: 7 + atomicCommand });
              }
              for (const operation of receipt.rows.slice(0, 2)) {
                const [mismatch, replaced] = operation.sourceRetirement;
                assert.equal(operation.sourceRetirement.length, 2);
                assert.equal(mismatch.case, "replacement-at-capture");
                assert.equal(mismatch.errorCode, "path-mismatch");
                assert.equal(mismatch.sourceConsumed, false);
                assert.equal(mismatch.recovery.status, "preserved");
                assert.equal(typeof mismatch.recovery.relativePath, "string");
                for (const field of ["originalTargetPreserved", "originalRetiredPreserved", "capturedReplacementPreserved", "publicReplacementPreserved", "dispatchRestored"]) {
                  assert.equal(mismatch[field], true, `source-capture proof missing ${field}`);
                }
                assert.equal(replaced.case, "public-replacement-after-capture");
                for (const field of ["sourceConsumed", "originalTargetPreserved", "publicReplacementPreserved", "privateCaptureRemoved", "dispatchRestored"]) {
                  assert.equal(replaced[field], true, `source-retirement proof missing ${field}`);
                }
                if (operation.scenario === "standalone-no-clobber-publication") {
                  assert.equal(replaced.errorCode, "path-mismatch");
                  assert.equal(replaced.cleanup, "preserved");
                  assert.equal(replaced.recoveryAbsent, true);
                } else assert.equal(Object.hasOwn(replaced, "errorCode"), false);
              }
            }
            cases.portableNoNative.push(receipt);
          }
        }
        if (!omitted) {
          const suffixProbe = join(directory, "suffix-probe.mjs");
          writeFileSync(suffixProbe, suffixProbeSource);
          writeFileSync(join(directory, "consumer-proof-metadata.mjs"), metadataHelperSource);
          cases.suffixAliases = [];
          for (const mode of ["off", "require"]) {
            const receipt = JSON.parse(await run([process.execPath, suffixProbe], [mode], directory, env));
            assert.equal(receipt.mode, mode);
            assert.deepEqual(receipt.packageManager, { name: manager, version });
            assert.deepEqual(receipt.source, source);
            assert.deepEqual(receipt.rows.map((row) => row.scenario), suffixScenarios);
            cases.suffixAliases.push(receipt);
          }
          const secretProbe = join(directory, "secret-probe.mjs");
          const sidecarProbe = join(directory, "sidecar-snapshot-probe.mjs");
          writeFileSync(secretProbe, readFileSync(new URL("./consumer-secret-probe.mjs", import.meta.url)));
          writeFileSync(sidecarProbe, readFileSync(new URL("./consumer-sidecar-snapshot-probe.mjs", import.meta.url)));
          cases.secretDirectories = [];
          cases.sidecarSnapshots = [];
          for (const mode of ["off", "require"]) {
            cases.secretDirectories.push(JSON.parse(await run([process.execPath, secretProbe], [mode], directory, env)));
            cases.sidecarSnapshots.push(JSON.parse(await run([process.execPath, sidecarProbe], [mode], directory, env)));
          }
          renameSync(installed.binary, `${installed.binary}.removed`);
          cases.missingBinaryAuto = await hash("auto");
          cases.missingBinaryRequire = await hash("require", true);
        }
        managerProof.cases.push(cases);
        console.log(`${manager}@${version} root-only ${omitted ? "omitted optionals" : host.label}: ${JSON.stringify(cases)}`);
      }
      proof.managers.push(managerProof);
    }
    console.log(`foreign filter fixtures: ${synthetic.length ? synthetic.join(", ") : "all seven collected native artifacts"}`);
    writeFileSync(join(outputDir, "consumer-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  } catch (error) {
    if (server) console.error(`consumer fixture requests: ${JSON.stringify(server.requests)}`);
    throw error;
  } finally {
    try { await server?.close(); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
