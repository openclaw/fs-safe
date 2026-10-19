import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNpmCli } from "../scripts/npm-cli.mjs";
import { normalizePackResult } from "../scripts/npm-pack-result.mjs";
import { assertPackedRuntimeFiles } from "../scripts/packed-runtime-files.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function pack(files: Record<string, string>, included = Object.keys(files)) {
  const directory = mkdtempSync(join(tmpdir(), "fs-safe-runtime-pack-"));
  directories.push(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "runtime-pack-fixture", version: "1.0.0", type: "module", files: included,
  }));
  for (const [path, content] of Object.entries(files)) {
    const destination = join(directory, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  const output = execFileSync(process.execPath, [resolveNpmCli(), "pack", "--json", "--ignore-scripts"], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.toLowerCase().startsWith("npm_config_"))),
  });
  const { filename } = normalizePackResult(JSON.parse(output), "runtime-pack-fixture");
  return join(directory, filename);
}

describe("packed runtime files", () => {
  it("checks imports, re-exports, require, workers and package-relative assets in the tarball", async () => {
    const archive = pack({
      "dist/index.js": `import './static.js';
        export * from './export.js';
        await import('./dynamic.js');
        require('../package.json');
        new Worker('./direct-worker.js');
        new Worker(new URL('./worker.js', import.meta.url));
        new URL('./parser.wasm', import.meta.url);
        import('node:fs'); import('external');
        const ignored = "import './not-code.js'";
        // new URL('./comment.js', import.meta.url)
      `,
      ...Object.fromEntries(["static.js", "export.js", "dynamic.js", "direct-worker.js", "worker.js", "parser.wasm"]
        .map(name => [`dist/${name}`, ""])),
    });
    await expect(assertPackedRuntimeFiles(archive)).resolves.toEqual({ modules: 6, references: 7 });
  }, 60_000);

  it("rejects a worker omitted by the files allowlist even when it exists in the source tree", async () => {
    const archive = pack({
      "dist/watch-io.js": 'new Worker(new URL("./watch-io-worker.js", import.meta.url));',
      "dist/watch-io-worker.js": "export {};",
    }, ["dist/watch-io.js"]);
    await expect(assertPackedRuntimeFiles(archive)).rejects.toThrow(
      "dist/watch-io.js: ./watch-io-worker.js -> dist/watch-io-worker.js",
    );
  }, 60_000);

  it("reports every missing import, re-export, require, worker and asset", async () => {
    const references = {
      static: "import './static.js';",
      reexport: "export { value } from './reexport.js';",
      dynamic: "import(`./dynamic.js`);",
      require: "require('./require.js');",
      worker: "new Worker('./worker.js');",
      asset: "new URL('./asset.js', import.meta.url);",
    };
    const result = assertPackedRuntimeFiles(pack({ "dist/index.js": Object.values(references).join("\n") }));
    for (const name of Object.keys(references)) {
      await expect(result).rejects.toThrow(`dist/index.js: ./${name}.js -> dist/${name}.js`);
    }
  }, 60_000);
});
