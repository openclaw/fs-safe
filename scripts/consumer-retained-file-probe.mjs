import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureFsSafeNative } from "@openclaw/fs-safe";
import { retainFileInDirectory } from "@openclaw/fs-safe/advanced";
import { creationCompiledFiles } from "./consumer-creation-contract.mjs";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";

configureFsSafeNative({ mode: "require" });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function options(directory) {
  const parent = fs.statSync(directory, { bigint: true });
  const file = fs.statSync(path.join(directory, "backup"), { bigint: true });
  return { directory, parent, basename: "backup", expected: { ...file, sha256: hash("original") }, assertBeforeMutation() {} };
}
function admit(directory) {
  const result = retainFileInDirectory(options(directory));
  assert.equal(result.status, "retained", result.status === "retained" ? undefined : JSON.stringify(result));
  return result.file;
}
if (process.argv[2] === "child") {
  const owner = admit(process.argv[3]);
  if (process.argv[4] === "settled") {
    assert.equal(owner.remove().status, "name-absent-after-settlement");
  }
  process.send({ phase: process.argv[4] });
  // The parent owns termination and joins exit; there is no background retry.
  process.on("message", () => owner.dispose());
} else {
  assert.equal(process.platform, "win32");
  const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@openclaw/fs-safe/package.json");
  const rootRequire = createRequire(manifest);
  const binary = rootRequire.resolve(expected.host.package);
  assert.equal(hash(fs.readFileSync(binary)), expected.hostBinarySha256);
  assert.equal(hash(fs.readFileSync(fileURLToPath(import.meta.url))), expected.retainedProbeSha256);
  const compiled = creationCompiledFiles(path.join(path.dirname(manifest), "dist"));
  assert.deepEqual(compiled, expected.creation.compiledFiles);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), "retained-fixture-")));
  const file = path.join(directory, "backup");
  const rows = [];
  try {
    fs.writeFileSync(file, "original");
    const owner = admit(directory);
    try {
      assert.throws(() => fs.writeFileSync(file, "newer"));
      assert.equal(owner.dispose().status, "not-attempted");
      assert.equal(fs.readFileSync(file, "utf8"), "original");
      rows.push("dispose-preserves");
    } finally { owner.dispose(); }
    for (const phase of ["admitted", "settled"]) {
      const child = fork(fileURLToPath(import.meta.url), ["child", directory, phase], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
      child.stdout.resume();
      const exited = once(child, "exit");
      let timer;
      try {
        const ready = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("message", (message) => message.phase === phase ? resolve() : reject(new Error("unexpected child phase")));
          child.once("exit", () => reject(new Error(`proof child exited before phase: ${stderr}`)));
          timer = setTimeout(() => reject(new Error("proof child did not reach phase")), 15000);
        });
        await ready;
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        await exited;
      }
      // Fresh process exit joins the OS-owned handles. This is not power-loss proof.
      assert.equal(fs.existsSync(file), phase === "admitted");
      if (phase === "admitted") {
        assert.equal(fs.readFileSync(file, "utf8"), "original");
        fs.writeFileSync(file, "original");
      }
      rows.push(`process-death-${phase}`);
    }
    assert.equal(nativeBinaryLoaded(binary), true);
    console.log(JSON.stringify({ protocol: 1, source: expected.source, rootIntegrity: expected.rootIntegrity,
      hostBinarySha256: expected.hostBinarySha256, compiledFiles: compiled, probeSha256: expected.retainedProbeSha256,
      nativeLoaded: true, platform: process.platform, arch: process.arch, node: process.version,
      packageManager: expected.manager, persistence: "not-proven", rows }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
