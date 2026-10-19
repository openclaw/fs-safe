import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
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
        new Worker(new URL('./worker.js', import.meta.url));
        new URL('./parser.wasm', import.meta.url);
        import('node:fs'); import('external');
        const ignored = "import './not-code.js'";
        // new URL('./comment.js', import.meta.url)
      `,
      ...Object.fromEntries(["static.js", "export.js", "dynamic.js", "worker.js", "parser.wasm"]
        .map(name => [`dist/${name}`, ""])),
    });
    await expect(assertPackedRuntimeFiles(archive)).resolves.toEqual({ modules: 5, references: 6 });
  }, 60_000);

  it("resolves URL queries, fragments and escaped names without decoding require paths", async () => {
    const archive = pack({
      "dist/index.js": `import './static.js?mode=isolated#part';
        export * from './export%20file.js';
        await import('./dynamic%23file.js?version=1');
        new Worker(new URL('./worker.js#v2', import.meta.url));
        new URL('./asset%20file.wasm?wasm#v1', import.meta.url);
        require('./literal%23file.js');
        require('./literal#file.js');
      `,
      ...Object.fromEntries(["static.js", "export file.js", "dynamic#file.js", "worker.js",
        "asset file.wasm", "literal%23file.js", "literal#file.js"].map(name => [`dist/${name}`, ""])),
    });
    await expect(assertPackedRuntimeFiles(archive)).resolves.toEqual({ modules: 7, references: 7 });
  }, 60_000);

  it("does not treat cwd-relative Worker strings as module-relative references", async () => {
    const archive = pack({ "dist/index.js": "new Worker('./cwd-worker.js');" });
    await expect(assertPackedRuntimeFiles(archive)).resolves.toEqual({ modules: 1, references: 0 });
  }, 60_000);

  it("keeps require percent escapes literal", async () => {
    const archive = pack({
      "dist/index.js": "require('./literal%23file.js');",
      "dist/literal#file.js": "",
    });
    await expect(assertPackedRuntimeFiles(archive)).rejects.toThrow(
      "dist/index.js: ./literal%23file.js -> dist/literal%23file.js",
    );
  }, 60_000);

  it("matches Node require file and directory resolution", async () => {
    const targets = {
      "./worker": "worker.js",
      "./settings": "settings.json",
      "./addon": "addon.node",
      "./directory": "directory/index.json",
      "./main-package": "main-package/lib/worker.js",
      "./nested-main": "nested-main/lib/index.js",
      "./fallback": "fallback/index.js",
    };
    const archive = pack({
      "dist/index.cjs": Object.keys(targets).map(name => `require(${JSON.stringify(name)});`).join("\n"),
      ...Object.fromEntries(Object.values(targets).map(name => [`dist/${name}`, name.endsWith(".json") ? "{}" : ""])),
      "dist/main-package/package.json": '{"main":"lib/worker"}',
      "dist/nested-main/package.json": '{"main":"lib"}',
      "dist/fallback/package.json": '{"main":"missing"}',
    });
    const require = createRequire(join(dirname(archive), "dist/index.cjs"));
    for (const [request, target] of Object.entries(targets)) {
      expect(require.resolve(request)).toBe(join(dirname(archive), "dist", target));
    }
    await expect(assertPackedRuntimeFiles(archive)).resolves.toEqual({ modules: 5, references: 7 });
  }, 60_000);

  it("does not resolve a trailing-slash require to a sibling JavaScript file", async () => {
    const archive = pack({
      "dist/index.cjs": "require('./worker/');",
      "dist/worker.js": "",
    });
    await expect(assertPackedRuntimeFiles(archive)).rejects.toThrow("dist/index.cjs: ./worker/ -> dist/worker/");
  }, 60_000);

  it("rejects an extensionless require whose source file was omitted from the tarball", async () => {
    const archive = pack({
      "dist/index.cjs": "require('./worker');",
      "dist/worker.js": "",
    }, ["dist/index.cjs"]);
    await expect(assertPackedRuntimeFiles(archive)).rejects.toThrow("dist/index.cjs: ./worker -> dist/worker");
  }, 60_000);

  it("does not resolve an escaping URL back into the package root", async () => {
    const archive = pack({ "dist/index.js": "import '../../package.json';" });
    await expect(assertPackedRuntimeFiles(archive)).rejects.toThrow(
      "dist/index.js: ../../package.json -> ../package.json",
    );
  }, 60_000);

  it("encodes the importing module path before resolving its URLs", async () => {
    const archive = pack({
      "dist/space # %20/index.js": "import './worker.js';",
      "dist/space # %20/worker.js": "",
    });
    await expect(assertPackedRuntimeFiles(archive)).resolves.toEqual({ modules: 2, references: 1 });
  }, 60_000);

  it("reports the decoded target of a missing module-relative URL", async () => {
    const archive = pack({ "dist/index.js": "new URL('./missing%20worker.js?mode=isolated#part', import.meta.url);" });
    await expect(assertPackedRuntimeFiles(archive)).rejects.toThrow(
      "dist/index.js: ./missing%20worker.js?mode=isolated#part -> dist/missing worker.js",
    );
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
      worker: "new Worker(new URL('./worker.js', import.meta.url));",
      asset: "new URL('./asset.js', import.meta.url);",
    };
    const result = assertPackedRuntimeFiles(pack({ "dist/index.js": Object.values(references).join("\n") }));
    for (const name of Object.keys(references)) {
      await expect(result).rejects.toThrow(`dist/index.js: ./${name}.js -> dist/${name}.js`);
    }
  }, 60_000);
});
