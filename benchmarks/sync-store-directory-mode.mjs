import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DEPTHS = Object.freeze([0, 4, 16]);
const LAYOUTS = Object.freeze(["same-mode", "different-mode", "new-directories"]);

export const SYNC_STORE_DIRECTORY_MODE_NAMES = Object.freeze(
  [false, true].flatMap(privateMode =>
    [false, true].flatMap(durable =>
      DEPTHS.flatMap(depth =>
        LAYOUTS.map(layout =>
          `FileStoreSync.write/directory-mode/${layout}/depth=${depth}` +
          `/private=${privateMode}/durable=${durable}`)))),
);

function directoryChain(rootDir, depth) {
  return [rootDir, ...Array.from({ length: depth }, (_, index) =>
    path.join(rootDir, ...Array.from({ length: index + 1 }, (__, part) => `d${part}`)))];
}

export function registerSyncStoreDirectoryModes({ api, workspace, register }) {
  let index = 0;
  for (const privateMode of [false, true]) {
    for (const durable of [false, true]) {
      for (const depth of DEPTHS) {
        for (const layout of LAYOUTS) {
          const name = SYNC_STORE_DIRECTORY_MODE_NAMES[index];
          const fixture = path.join(workspace, `sync-store-directory-mode-${index}`);
          const rootDir = path.join(fixture, "store");
          const components = Array.from({ length: depth }, (_, part) => `d${part}`);
          const key = [...components, "value"].join("/");
          const target = path.join(rootDir, ...components, "value");
          const directories = directoryChain(rootDir, depth);
          const store = api.fileStoreSync({ rootDir, private: privateMode, dirMode: 0o750 });
          let previousUmask;
          register(name, () => store.write(key, "directory mode benchmark", { durable }), {
            sync: true,
            divisor: 20,
            before: () => {
              fs.rmSync(fixture, { recursive: true, force: true });
              fs.mkdirSync(fixture);
              if (layout === "new-directories") {
                if (process.platform !== "win32") previousUmask = process.umask(0o077);
                return;
              }
              fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
              for (const directory of directories) {
                fs.chmodSync(directory, layout === "same-mode" ? 0o750 : 0o755);
              }
            },
            verify: result => {
              assert.equal(result, target);
              assert.equal(fs.readFileSync(target, "utf8"), "directory mode benchmark");
              if (process.platform !== "win32") {
                for (const directory of directories) {
                  assert.equal(fs.statSync(directory).mode & 0o7777, 0o750);
                }
              }
            },
            after: () => {
              if (previousUmask !== undefined) {
                process.umask(previousUmask);
                previousUmask = undefined;
              }
              fs.rmSync(fixture, { recursive: true, force: true });
            },
          });
          index += 1;
        }
      }
    }
  }
  assert.equal(index, SYNC_STORE_DIRECTORY_MODE_NAMES.length);
}
