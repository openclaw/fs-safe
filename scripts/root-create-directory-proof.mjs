import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const modes = ["off", "auto", "require"];
if (mode === undefined) {
  const reports = modes.map(selected => {
    const child = spawnSync(process.execPath, [script, selected], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, FS_SAFE_NATIVE_MODE: selected },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  });
  for (const report of reports.slice(1)) assert.deepEqual(report.cases, reports[0].cases);
  console.log(JSON.stringify({ platform: process.platform, reports }));
} else {
  assert.ok(modes.includes(mode));
  process.env.FS_SAFE_NATIVE_MODE = mode;
  const loads = [];
  let loadAttempts = 0;
  const dlopen = process.dlopen;
  process.dlopen = function(module, filename, ...rest) {
    loadAttempts++;
    const result = Reflect.apply(dlopen, this, [module, filename, ...rest]);
    loads.push(path.basename(filename));
    return result;
  };
  const { root } = await import("../dist/index.js");
  const { sha256File } = await import("../dist/durability.js");
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-create-directory-")));
  const cases = [];
  try {
    const source = path.join(directory, "source");
    fs.writeFileSync(source, "source");
    await sha256File(source);
    assert.equal(loads.length > 0, mode !== "off", "prove native loading instead of assuming auto loaded it");
    if (mode === "off") assert.equal(loadAttempts, 0);
    const names = ["create", "atomic-create", "stream-create", "createJson", "atomic-createJson",
      "write-exclusive", "writeJson-exclusive", "copy-exclusive"];
    for (const name of names) {
      const parent = path.join(directory, name);
      const destination = path.join(parent, "existing");
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "sentinel"), "unchanged");
      const files = await root(parent, { durable: false });
      let consumed = false;
      const stream = (async function* () { consumed = true; yield Buffer.from("replacement"); })();
      const operations = {
        create: () => files.create("existing", "replacement"),
        "atomic-create": () => files.create("existing", "replacement", { atomic: true }),
        "stream-create": () => files.create("existing", stream),
        createJson: () => files.createJson("existing", { replacement: true }),
        "atomic-createJson": () => files.createJson("existing", {}, { atomic: true }),
        "write-exclusive": () => files.write("existing", "replacement", { overwrite: false }),
        "writeJson-exclusive": () => files.writeJson("existing", {}, { overwrite: false }),
        "copy-exclusive": () => files.copyIn("existing", source, { overwrite: false }),
      };
      let error;
      try { await operations[name](); } catch (caught) { error = caught; }
      const outcome = { name: error?.name, code: error?.code, category: error?.category };
      assert.deepEqual(outcome, { name: "FsSafeError", code: "already-exists", category: "policy" }, name);
      assert.equal(consumed, false);
      assert.ok(fs.lstatSync(destination).isDirectory());
      assert.equal(fs.readFileSync(path.join(destination, "sentinel"), "utf8"), "unchanged");
      assert.deepEqual(fs.readdirSync(parent), ["existing"]);
      assert.deepEqual(fs.readdirSync(destination), ["sentinel"]);
      cases.push({ operation: name, outcome, contents: "unchanged", consumed });
    }
    const windowsLinks = [];
    if (process.platform === "win32") {
      for (const kind of ["final-link", "parent-junction"]) {
        for (const policy of ["omitted", "reject", "compatibility"]) {
          const parent = path.join(directory, `${kind}-${policy}`);
          fs.mkdirSync(path.join(parent, "actual"), { recursive: true });
          const target = path.join(parent, "actual", "target");
          fs.writeFileSync(target, "original");
          const alias = path.join(parent, "alias");
          fs.symlinkSync(kind === "final-link" ? target : path.dirname(target), alias,
            kind === "final-link" ? "file" : "junction");
          const files = await root(parent, { durable: false });
          const options = policy === "reject" ? { mutationSymlinks: "reject" }
            : policy === "compatibility" ? { renameIdentity: "verify-content-with-lock" } : {};
          let error;
          try { await files.write(kind === "final-link" ? "alias" : "alias/target", "replacement", options); }
          catch (caught) { error = caught; }
          const expected = policy === "reject" ? "symlink"
            : mode !== "off" && policy !== "compatibility"
              ? kind === "final-link" ? "path-alias" : "invalid-path"
              : undefined;
          assert.equal(error?.code, expected, `${mode}/${kind}/${policy}`);
          if (expected !== undefined) {
            assert.equal(error.name, "FsSafeError");
            assert.equal(error.category, "policy");
          }
          const content = fs.readFileSync(target, "utf8");
          assert.equal(content, expected === undefined ? "replacement" : "original");
          assert.ok(fs.lstatSync(alias).isSymbolicLink());
          assert.deepEqual(fs.readdirSync(parent).sort(), ["actual", "alias"]);
          windowsLinks.push({ kind, policy, code: error?.code ?? null, content, linkPreserved: true });
        }
      }
    }
    console.log(JSON.stringify({
      runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.versions.node}`,
      mode, loads, cases, windowsLinks,
    }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
