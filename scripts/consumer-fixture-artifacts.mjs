import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePackageDirectory, nativeTargets } from "./native-targets.mjs";
import { normalizePackResult } from "./npm-pack-result.mjs";

const readPackage = (directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

function dependencyDirectory(name, directory) {
  const require = createRequire(join(directory, "package.json"));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let candidate = dirname(require.resolve(name));
    for (;;) {
      try {
        if (readPackage(candidate).name === name) return candidate;
      } catch { /* An entry point can be nested below its package manifest. */ }
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`cannot locate installed dependency ${name}`);
      candidate = parent;
    }
  }
}

export async function consumerFixtureArtifacts({ rootPkg, manifest, outputDir, fixtureDir, runNpm, allowHostOnly }) {
  const artifacts = [];
  const synthetic = [];
  async function pack(directory) {
    const pkg = readPackage(directory);
    let parsed;
    try {
      parsed = JSON.parse(await runNpm([
        "pack", "--json", "--ignore-scripts", "--loglevel=verbose", "--pack-destination", fixtureDir,
      ], directory));
    } catch (cause) {
      throw new Error(`could not pack consumer fixture ${pkg.name}@${pkg.version}`, { cause });
    }
    const { filename } = normalizePackResult(parsed, pkg.name);
    artifacts.push({ pkg, tarball: join(fixtureDir, filename) });
  }
  for (const pkg of [rootPkg, ...nativeTargets.map((target) => readPackage(fileURLToPath(nativePackageDirectory(target))))]) {
    const entry = manifest.find((artifact) => artifact.name === pkg.name);
    if (pkg.name !== rootPkg.name) {
      assert.equal(rootPkg.optionalDependencies[pkg.name], rootPkg.version);
      assert.equal(pkg.version, rootPkg.version);
    }
    if (entry) {
      artifacts.push({ pkg, tarball: join(outputDir, entry.filename), integrity: entry.integrity });
    } else {
      assert.ok(allowHostOnly, `missing release artifact ${pkg.name}`);
      const directory = join(fixtureDir, pkg.name.split("/").at(-1));
      mkdirSync(directory);
      // Keep the production manifest byte-for-byte equivalent. Only the foreign
      // payload is synthetic, outside both packages/ and release-artifacts/.
      writeFileSync(join(directory, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      writeFileSync(join(directory, pkg.main), "SYNTHETIC FOREIGN INSTALLER FILTER FIXTURE; NOT EXECUTABLE\n");
      await pack(directory);
      synthetic.push(pkg.name);
    }
  }
  // Include real installed archive codecs and their dependency graph. The
  // fixture never proxies a missing dependency to any external registry.
  const seen = new Set();
  async function collect(name, from) {
    const directory = dependencyDirectory(name, from);
    const pkg = readPackage(directory);
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    await pack(directory);
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      await collect(dependency, directory);
    }
  }
  for (const name of Object.keys(rootPkg.optionalDependencies)) {
    if (!nativeTargets.some((target) => target.package === name)) await collect(name, process.cwd());
  }
  return { artifacts, synthetic };
}
