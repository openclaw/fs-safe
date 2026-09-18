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
const windowsSecurityModules = [
  "bounded-read.js", "byte-budget.js", "config.js", "device-path.js", "effective-uid.js",
  "error-detail.js", "errors.js", "file-observation.js", "local-file-access.js", "lock-config.js",
  "native-binding.js", "native-config.js", "native-fallback-warning.js", "native.js", "owner-dacl.js",
  "path.js", "permission-exec.js", "permissions-public.js", "permissions-windows.js", "permissions.js",
  "private-directory.js", "read-open-flags.js", "realpath.js", "safe-path-segment.js", "secure-file-windows.js",
  "secure-file.js", "strict-file-identity.js", "string-coerce.js", "timing.js", "windows-command.js",
  "windows-owner.js", "windows-path-alias.js", "windows-security-command.js", "windows-security-facts.js",
];
const windowsSecurityAssets = ["windows-security-bridge.cs", "windows-security-bridge.ps1"];
const windowsSecurityScenarios = [
  "private-directory-created", "private-directory-created-repeat", "raw-owner-and-dacl", "raw-owner-and-dacl-repeat",
  "private-directory-collision", "populated-private-directory-collision", "descriptor-secure-read", "descriptor-secure-read-repeat",
  "broad-acl-rejected-before-read", "explicit-readable-policy", "broad-write-rejected-with-readable-opt-in",
  "replaced-path-rejected-before-read",
];
const windowsSecurityTimingPairs = [
  ["createPrivateDirectory", "private-directory-created", "private-directory-created-repeat"],
  ["readOwnerAndDacl", "raw-owner-and-dacl", "raw-owner-and-dacl-repeat"],
  ["readSecureFile", "descriptor-secure-read", "descriptor-secure-read-repeat"],
];
const windowsSecurityRequireScenarios = [
  "require-owner-fails-closed", "require-private-directory-fails-closed", "require-secure-read-fails-closed",
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
    const metadataHelperSource = readFileSync(new URL("./consumer-proof-metadata.mjs", import.meta.url));
    const windowsSecurityProbeSource = readFileSync(new URL("./consumer-windows-security-probe.mjs", import.meta.url));
    const windowsSecurityExpected = process.platform === "win32" ? {
      protocol: 2,
      compiledSha256: Object.fromEntries(windowsSecurityModules.map((name) => [name, sha256(join("dist", name))])),
      assetsSha256: Object.fromEntries(windowsSecurityAssets.map((name) => [name, sha256(join("dist", name))])),
      probeSha256: createHash("sha256").update(windowsSecurityProbeSource).digest("hex"),
    } : undefined;
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
          windowsSecurity: windowsSecurityExpected,
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
        if (process.platform === "win32") {
          const probe = join(directory, "windows-security-probe.mjs");
          writeFileSync(probe, windowsSecurityProbeSource);
          writeFileSync(join(directory, "consumer-proof-metadata.mjs"), metadataHelperSource);
          cases.windowsSecurity = [];
          for (const mode of omitted ? ["off", "auto", "require"] : ["require"]) {
            const receipt = JSON.parse(await run([process.execPath, probe], [mode], directory, env));
            assert.equal(receipt.protocol, 2);
            assert.equal(receipt.mode, mode);
            assert.equal(receipt.omitted, omitted);
            assert.equal(receipt.nativeLoaded, !omitted);
            assert.deepEqual(receipt.packageManager, { name: manager, version });
            assert.deepEqual(receipt.source, source);
            assert.equal(receipt.rootPackage.integrity, rootArtifact.integrity);
            assert.deepEqual(receipt.compiledModules, windowsSecurityExpected.compiledSha256);
            assert.deepEqual(receipt.scriptAssets, windowsSecurityExpected.assetsSha256);
            assert.deepEqual(receipt.rows.map((row) => row.scenario),
              omitted && mode === "require" ? windowsSecurityRequireScenarios : windowsSecurityScenarios);
            cases.windowsSecurity.push(receipt);
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
      if (process.platform === "win32") {
        const native = managerProof.cases.find((item) => !item.omitted).windowsSecurity[0];
        const portable = managerProof.cases.find((item) => item.omitted).windowsSecurity;
        const measuredPair = (receipt, first, repeated) => Object.fromEntries([
          ["firstCall", first], ["repeatedCall", repeated],
        ].map(([label, scenario]) => {
          const row = receipt.rows.find((item) => item.scenario === scenario);
          return [label, { publicDurationMs: row.publicCallDurationMs,
            childCommands: row.commands.map(({ pid, durationMs }) => ({ pid, durationMs })) }];
        }));
        managerProof.windowsSecurityTiming = {
          unit: "milliseconds", samplesPerOperationAndMode: 2,
          interpretation: "First versus repeated invocation of the same public operation in one consumer process. Each portable call still launches and compiles a fresh PowerShell child; there is no persistent warm helper. Informational measurements without timing thresholds or performance guarantees.",
          firstAndRepeated: windowsSecurityTimingPairs.map(([operation, first, repeated]) => ({
            operation,
            nativeRequire: measuredPair(native, first, repeated),
            portableOff: measuredPair(portable.find((item) => item.mode === "off"), first, repeated),
            portableAuto: measuredPair(portable.find((item) => item.mode === "auto"), first, repeated),
          })),
        };
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
