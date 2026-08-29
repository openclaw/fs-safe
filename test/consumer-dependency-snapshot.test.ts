import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { afterEach, expect, it } from "vitest";
import { snapshotConsumerDependency } from "../scripts/consumer-fixture-artifacts.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("snapshots installed payloads without source packing rules or dependency links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fs-safe-dependency-snapshot-"));
  directories.push(directory);
  const installed = join(directory, "installed");
  const artifacts = join(directory, "artifacts");
  const consumer = join(directory, "consumer");
  await Promise.all([mkdir(installed), mkdir(artifacts), mkdir(consumer)]);
  // A published payload can retain source-only publishing metadata. The
  // resolver fixture needs installed bytes, not another publication build.
  const pkg = {
    name: "published-codec", version: "1.2.3", main: "runtime.js", files: ["source"],
    scripts: { prepack: "exit 99" }, dependencies: { dependency: "1.0.0" },
  };
  const manifest = `${JSON.stringify(pkg, null, 2)}\n`;
  await writeFile(join(installed, "package.json"), manifest);
  await writeFile(join(installed, "runtime.js"), "module.exports = 'published bytes';\n");
  await mkdir(join(installed, "node_modules"));
  await writeFile(join(installed, "node_modules", "unrelated"), "must not be bundled");

  const artifact = await snapshotConsumerDependency(installed, artifacts);
  expect(artifact.pkg).toEqual(pkg);
  await extract({ file: artifact.tarball, cwd: consumer });
  expect((await readdir(join(consumer, "package"))).sort()).toEqual(["package.json", "runtime.js"]);
  expect(await readFile(join(consumer, "package", "package.json"), "utf8")).toBe(manifest);
  expect(await readFile(join(consumer, "package", "runtime.js"), "utf8")).toBe("module.exports = 'published bytes';\n");
});
