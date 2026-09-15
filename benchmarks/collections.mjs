import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const LONG_NAME_INPUTS = Object.freeze([
  ["ascii", `${"a".repeat(195)}.txt`],
  ["unicode", `${"é".repeat(80)}.txt`],
]);
const LONG_NAME_ENDPOINTS = Object.freeze([
  "writeViaSiblingTempPath",
  "writeExternalFileWithinRoot",
]);
export const LONG_NAME_BENCHMARK_NAMES = Object.freeze(
  LONG_NAME_INPUTS.flatMap(([kind]) =>
    LONG_NAME_ENDPOINTS.map((endpoint) => `${endpoint}/long-name-${kind}`)),
);

export async function registerCollections({ api: a, workspace: w, register: add }) {
  const stores = [["FileStore", a.fileStore({ rootDir: w })], ["FileStoreSync", a.fileStoreSync({ rootDir: w })]];
  for (const [form, word] of [["ascii", "component"], ["nfc", "café-日本語"], ["nfd", "cafe\u0301-日本語"]]) {
    for (const depth of [1, 8, 32]) {
      const name = Array.from({ length: depth }, (_, index) => `${word}-${index}`).join("/");
      add(`validateArchiveEntryPath/${form}/depth=${depth}`, () => a.validateArchiveEntryPath(name), {
        sync: true, batch: 100,
      });
      add(`isWindowsDrivePath/${form}/depth=${depth}`, () => a.isWindowsDrivePath(name), {
        sync: true, batch: 100, verify: value => assert.equal(value, false),
      });
      for (const [type, store] of stores) {
        add(`${type}.path/${form}/depth=${depth}`, () => store.path(name), {
          sync: true, batch: form === "nfd" ? 1 : 100, expectError: form === "nfd",
          verify: value => form === "nfd" ? assert.equal(value.code, "invalid-path")
            : assert.equal(value, path.join(w, name)),
        });
      }
    }
  }
  for (const depth of [1, 8, 32]) {
    const name = `${"component/".repeat(depth - 1)}C:relative`;
    add(`isWindowsDrivePath/drive-at-end/depth=${depth}`, () => a.isWindowsDrivePath(name), {
      sync: true, batch: 100, verify: value => assert.equal(value, true),
    });
  }
  for (const [reason, name] of [["parent", "a/../b"], ["absolute", "/absolute"], ["drive", "a/C:relative"],
    ["nul", "a\0b"], ["component-budget", `a/${"x".repeat(256)}`]]) {
    add(`validateArchiveEntryPath/rejected-${reason}`, () => a.validateArchiveEntryPath(name), {
      sync: true, expectError: true, verify: error => assert.equal(error.code, "entry-path"),
    });
  }

  const destination = path.join(w, "collection-output");
  fs.mkdirSync(destination);
  for (const unicode of [false, true]) {
    for (const depth of [1, 8]) {
      const word = unicode ? "café-日本語" : "component";
      const parent = `${word}/`.repeat(depth - 1);
      const names = Array.from({ length: 2048 }, (_, index) => `${parent}${word}-${index}`);
      const zip = new JSZip(), payload = Buffer.from("data");
      for (const name of names) zip.file(name, payload, { createFolders: false });
      const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
      const label = `zip-2048-${unicode ? "unicode" : "ascii"}-depth=${depth}`;
      const archivePath = path.join(w, `${label}.zip`);
      fs.writeFileSync(archivePath, bytes);
      add(`loadZipArchiveWithPreflight/${label}`, () => a.loadZipArchiveWithPreflight(bytes), {
        divisor: 100, verify: result => assert.equal(Object.keys(result.files).length, names.length),
      });
      add(`readArchiveEntry/${label}`, () => a.readArchiveEntry(archivePath, names.at(-1), { maxBytes: 4 }), {
        divisor: 100, verify: result => assert.ok(result.equals(payload)),
      });
      add(`extractArchive/${label}-skip-all`, async () => {
        let inspected = 0;
        await a.extractArchive({ archivePath, destDir: destination, timeoutMs: 30_000,
          entryFilter: () => { inspected++; return "skip"; }, onFiltered: "skip-entry" });
        return inspected;
      }, { divisor: 100, verify: count => {
        assert.equal(count, names.length);
        assert.deepEqual(fs.readdirSync(destination), []);
      } });
    }
  }
  for (const [kind, name] of LONG_NAME_INPUTS) {
    const targetPath = path.join(w, name);
    let stagedPath;
    const write = async file => {
      stagedPath = file;
      await fs.promises.writeFile(file, "data");
    };
    const before = () => {
      assert.equal(fs.existsSync(targetPath), false);
      stagedPath = undefined;
    };
    const after = () => {
      try {
        assert.equal(fs.readFileSync(targetPath, "utf8"), "data");
        assert.equal(typeof stagedPath, "string");
        assert.notEqual(path.resolve(stagedPath), path.resolve(targetPath));
        const component = path.basename(stagedPath);
        const normalizedBytes = ["NFC", "NFD"].map((form) =>
          Buffer.byteLength(component.normalize(form)));
        assert.ok(Math.max(...normalizedBytes) <= 255);
        assert.ok(component.endsWith(".txt.part"));
        assert.equal(fs.existsSync(stagedPath), false);
      } finally {
        fs.rmSync(targetPath, { force: true });
        if (stagedPath) fs.rmSync(stagedPath, { force: true });
      }
    };
    add(`writeViaSiblingTempPath/long-name-${kind}`, () => a.writeViaSiblingTempPath({ rootDir: w, targetPath, writeTemp: write }), {
      divisor: 100, before, after, workloadSemantics: "equivalent-output",
    });
    add(`writeExternalFileWithinRoot/long-name-${kind}`, () => a.writeExternalFileWithinRoot({ rootDir: w, path: name, staging: "sibling", write }), {
      divisor: 100, before, after, workloadSemantics: "equivalent-output",
    });
  }
}
