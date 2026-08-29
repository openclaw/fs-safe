import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { consumerFixtureArtifacts } from "./consumer-fixture-artifacts.mjs";
import { startConsumerRegistry } from "./consumer-registry.mjs";
import { hostNativeTarget, nativeTargets } from "./native-targets.mjs";

const exec = promisify(execFile);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

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
  env.CI = "true";
  return env;
}

async function run(cli, args, cwd, env) {
  // Async children leave the test-owned registry's event loop available.
  const { stdout } = await exec(process.execPath, [cli, ...args], {
    cwd, env, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

export function resolvePnpmCli(cli = process.env.npm_execpath) {
  const resolved = cli && isAbsolute(cli) && statSync(cli, { throwIfNoEntry: false })?.isFile()
    ? realpathSync(cli) : undefined;
  if (resolved && /^pnpm\.(?:c?js|mjs)$/.test(basename(resolved))) return resolved;
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
    const result=await sha256File('fixture.txt');
    assert.equal(result.digest,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    console.log(result.digest);
  }
`;

export async function consumerInstallSmoke({ rootPkg, manifest, outputDir, npmCli, pnpmCli, allowHostOnly }) {
  const temporary = mkdtempSync(join(tmpdir(), "fs-safe-consumer-proof-"));
  let server;
  try {
    const fixtureDir = join(temporary, "registry-artifacts");
    mkdirSync(fixtureDir);
    const packingEnv = isolatedConsumerEnv(join(temporary, "packing-config"));
    const { artifacts, synthetic } = await consumerFixtureArtifacts({
      rootPkg, manifest, outputDir, fixtureDir, allowHostOnly,
      runNpm: (args, cwd) => run(npmCli, args, cwd, packingEnv),
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
    const proof = {
      host: host.label, node: process.version,
      root: manifest.find((artifact) => artifact.name === rootPkg.name),
      syntheticForeignPackages: synthetic, managers: [],
    };
    for (const [manager, cli] of [["npm", npmCli], ["pnpm", pnpmCli]]) {
      const managerProof = { manager, cases: [] };
      for (const omitted of [false, true]) {
        const directory = join(temporary, `${manager}-${omitted ? "omitted" : "normal"}`);
        mkdirSync(directory);
        const env = isolatedConsumerEnv(join(directory, "config"));
        env.npm_config_registry = server.registry;
        const version = await run(cli, ["--version"], directory, env);
        if (manager === "pnpm") assert.equal(`pnpm@${version}`, rootPkg.packageManager);
        managerProof.version = version;
        writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
        const args = manager === "npm"
          ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...(omitted ? ["--omit=optional"] : [])]
          : ["add", "--ignore-scripts", "--ignore-workspace", "--store-dir", join(directory, "store"), ...(omitted ? ["--no-optional"] : [])];
        // The only requested package is the root; its exact optional pins are untouched.
        args.push(`${rootPkg.name}@${rootPkg.version}`, "--registry", server.registry);
        await run(cli, args, directory, env);
        assert.deepEqual(Object.keys(readJson(join(directory, "package.json")).dependencies), [rootPkg.name]);
        const lockfile = readFileSync(join(directory, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"), "utf8");
        const rootArtifact = artifacts.find((artifact) => artifact.pkg.name === rootPkg.name);
        assert.ok(lockfile.includes(rootArtifact.integrity), "lockfile must pin the collected root tarball integrity");
        writeFileSync(join(directory, "expected.json"), JSON.stringify({
          rootPkg, host, omitted, platforms: nativeTargets.map((target) => target.package),
          entryHash: createHash("sha256").update(readFileSync("dist/index.js")).digest("hex"),
        }));
        writeFileSync(join(directory, "probe.mjs"), readFileSync(new URL("./consumer-install-probe.mjs", import.meta.url)));
        await run(join(directory, "probe.mjs"), [], directory, env);
        const installed = readJson(join(directory, "installed.json"));
        writeFileSync(join(directory, "fixture.txt"), "abc");
        async function hash(mode, missing = false) {
          return run("--input-type=module", ["--eval", hashScript, mode, missing ? "missing" : "present"], directory, env);
        }
        const cases = { omitted, nativePackages: installed.nativePackages };
        cases.require = await hash("require", omitted);
        cases.auto = await hash("auto");
        cases.off = await hash("off");
        if (!omitted) {
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
