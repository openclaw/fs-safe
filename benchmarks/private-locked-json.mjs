import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PAYLOAD = "private locked JSON admission";

export function registerPrivateLockedJson({ api, workspace, register }) {
  for (const depth of [0, 8]) {
    const rootDir = path.join(workspace, `private-locked-json-${depth}`);
    const directories = [rootDir];
    fs.mkdirSync(rootDir, { mode: 0o700 });
    for (let index = 0; index < depth; index++) {
      const directory = path.join(directories.at(-1), `level-${index}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      directories.push(directory);
    }
    const filePath = path.join(directories.at(-1), "state.json");
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join("/");
    fs.writeFileSync(filePath, `${JSON.stringify({ count: 0, payload: PAYLOAD }, null, 2)}\n`, { mode: 0o600 });
    const document = api.fileStore({ rootDir, private: true }).json(relativePath, { lock: true, durable: false });
    let completed = 0;
    register(`JsonStore.update/private=true/lock=true/${depth === 0 ? "flat" : "depth=8"}/durable=false`,
      () => document.update(value => ({ count: value.count + 1, payload: value.payload })), {
        workloadSemantics: "Private locked JSON update with an existing admitted parent; validation follows every invocation outside its timer.",
        workloadDetails: { depth, relativePath, private: true, lock: true, durable: false, fileMode: 0o600, directoryMode: 0o700 },
        after: result => {
          const expected = { count: completed + 1, payload: PAYLOAD };
          assert.deepEqual(result, expected, "locked update must return the next complete document");
          assert.equal(fs.readFileSync(filePath, "utf8"), `${JSON.stringify(expected, null, 2)}\n`, "locked update must publish exact JSON");
          if (process.platform !== "win32") {
            assert.equal(fs.statSync(filePath).mode & 0o7777, 0o600, "private file mode changed");
            for (const directory of directories) assert.equal(fs.statSync(directory).mode & 0o7777, 0o700, "private directory mode changed");
          }
          for (const [index, directory] of directories.entries()) {
            const entries = index === depth ? ["state.json"] : [path.basename(directories[index + 1])];
            assert.deepEqual(fs.readdirSync(directory).sort(), entries, "locked update must release its sidecar and leave no extra entries");
          }
          completed++;
        },
      });
  }
}
