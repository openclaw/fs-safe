import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({ options: {
  "package-root": { type: "string", default: path.resolve(import.meta.dirname, "..") },
  "expect-native-rejection": { type: "boolean", default: false },
} });
assert.equal(process.platform, "win32", "This proof requires Windows");
const root = path.resolve(values["package-root"]);
const load = name => import(pathToFileURL(path.join(root, "dist", name)).href);
const { configureFsSafeNative } = await load("native-config.js");
configureFsSafeNative({ mode: "require" });
const { getNativeBinding } = await load("native.js");
const { inspectPathPermissions } = await load("permissions.js");
const { readSecureFile } = await load("secure-file.js");
const native = getNativeBinding("readOwnerAndDacl", "createPrivateDirectory");
const require = createRequire(path.join(root, "dist", "native.js"));
const binary = await fs.realpath(require.resolve("@openclaw/fs-safe-win32-x64-msvc"));
assert.equal(binary, await fs.realpath(path.join(root, "packages", "win32-x64-msvc", "fs-safe-native.node")));
const binarySha256 = crypto.createHash("sha256").update(await fs.readFile(binary)).digest("hex");
const ref = "bcfc88812a35243893585dbeca87ca41b48272ca";
const url = `https://raw.githubusercontent.com/openclaw/openclaw/${ref}/extensions/browser/src/browser/extension-install-layout.ts`;
const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
assert.ok(response.ok, `Core source download failed: ${response.status}`);
const source = await response.text();
const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
assert.equal(sourceSha256, "bd5058494aab3f8808b0c2f59a44e5a0dda64c4c201f3994046422e67838f05a");

// Execute the entire pinned module, changing only import wiring and TS syntax.
// The state/environment injection is its existing ExtensionInstallDeps seam.
const allowedImports = new Set([
  "node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path",
  "openclaw/plugin-sdk/file-access-runtime", "openclaw/plugin-sdk/state-paths",
]);
const executable = stripTypeScriptTypes(source)
  .replace(/^import .+ from "([^"]+)";\r?$/gm, (_line, specifier) => {
    assert.ok(allowedImports.delete(specifier), `Unexpected core import: ${specifier}`);
    return "";
  }).replace(/^export /gm, "");
assert.equal(allowedImports.size, 0, "Not all core imports were rewired");
const effects = { copies: 0, preferenceReads: 0 };
const observedFs = new Proxy(fs, {
  get(target, property) {
    if (property === "copyFile") return async (...args) => {
      effects.copies++;
      return await target.copyFile(...args);
    };
    if (property === "readFile") return async (...args) => {
      if (["Preferences", "Secure Preferences"].includes(path.basename(String(args[0])))) effects.preferenceReads++;
      return await target.readFile(...args);
    };
    return target[property];
  },
});
let fallbackCalls = 0;
const publicInspector = async target => await inspectPathPermissions(target, {
  exec: async () => { fallbackCalls++; throw new Error("Unexpected native fallback"); },
});
const browser = new Function(
  "crypto", "fsConstants", "fs", "os", "path", "inspectPathPermissions", "resolveStateDir",
  `${executable}\nreturn { installStableChromeExtension, discoverChromeExtensionIds };`,
)(crypto, fsConstants, observedFs, os, path, publicInspector,
  () => { throw new Error("Unexpected global state lookup"); });
const installer = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const cases = [
  ["TrustedInstaller", installer, true],
  ["unrelated-service", "s-1-5-80-0", true],
  ["LocalService", "s-1-5-19", true],
  ["Users", "s-1-5-32-545", true],
  ["Everyone", "s-1-1-0", true],
];
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-browser-acl-")));
const records = [];
function privateDirectory(target) {
  native.createPrivateDirectory(target);
  return target;
}
function grant(target, sid, rights = "F") {
  const command = path.join(process.env.SystemRoot, "System32", "icacls.exe");
  execFileSync(command, [target, "/grant", `*${sid}:${rights}`, "/q"], {
    stdio: "pipe", windowsHide: true, timeout: 30_000,
  });
}
async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
try {
  for (const [label, sid, unsafe] of cases) {
    const cell = privateDirectory(path.join(scratch, label));
    const sourceDir = privateDirectory(path.join(cell, "source"));
    await fs.writeFile(path.join(sourceDir, "manifest.json"), '{"manifest_version":3,"name":"Synthetic","version":"1"}');
    grant(sourceDir, installer, "(OI)(CI)F");
    if (unsafe) grant(sourceDir, sid, "(OI)(CI)F");
    const facts = native.readOwnerAndDacl(sourceDir);
    assert.equal(facts.fallbackRequired, false);
    assert.ok(["current-user", "administrators"].includes(facts.ownerClass));
    assert.ok(facts.aces.some(ace => ace.sid === sid && ace.aceType === "allow" && !ace.flags.inheritOnly && ace.mask === 0x001f01ff));
    const stateDir = privateDirectory(path.join(cell, "state"));
    const deps = { stateDir, env: { LOCALAPPDATA: cell }, homeDir: cell };
    const beforeCopies = effects.copies;
    let refused = false;
    try { await browser.installStableChromeExtension(sourceDir, deps); }
    catch (error) {
      assert.match(error.message, /^Refusing unsafe Windows owner or ACL at /);
      refused = true;
    }
    const expectedRefusal = unsafe || values["expect-native-rejection"];
    assert.equal(refused, expectedRefusal, `${label} source admission`);
    const target = path.join(stateDir, "browser", "chrome-extension");
    assert.equal(await exists(target), !expectedRefusal);
    assert.equal(effects.copies - beforeCopies, expectedRefusal ? 0 : 1);
    if (!expectedRefusal) {
      const destination = native.readOwnerAndDacl(target);
      assert.ok(["current-user", "administrators"].includes(destination.ownerClass));
      assert.equal(destination.groupWritable, false);
      assert.equal(destination.worldWritable, false);
      assert.equal(JSON.parse(await fs.readFile(path.join(target, "manifest.json"), "utf8")).name, "Synthetic");
      assert.equal(JSON.parse((await readSecureFile({
        filePath: path.join(target, "manifest.json"),
      })).buffer.toString("utf8")).name, "Synthetic");
    }
    records.push({ boundary: "source-before-copy", principal: label, refused, copyCalls: effects.copies - beforeCopies, destinationPublished: !expectedRefusal });

    // A safe source must not permit an unsafe existing writable destination.
    if (unsafe) {
      const safeSource = privateDirectory(path.join(cell, "safe-source"));
      await fs.writeFile(path.join(safeSource, "manifest.json"), "{}");
      const browserDir = privateDirectory(path.join(stateDir, "browser"));
      const destination = privateDirectory(path.join(browserDir, "chrome-extension"));
      await fs.writeFile(path.join(destination, ".openclaw-owned.json"), '{"v":1}');
      grant(destination, sid, "(OI)(CI)F");
      const count = effects.copies;
      await assert.rejects(browser.installStableChromeExtension(safeSource, deps), /Refusing unsafe Windows owner or ACL/);
      assert.equal(effects.copies, count);
      assert.deepEqual(await fs.readdir(destination), [".openclaw-owned.json"]);
      records.push({ boundary: "destination-before-copy", principal: label, refused: true, copyCalls: 0, existingDestinationUnchanged: true });
    }

    // Profile discovery uses the same inspector before reading Preferences.
    const userData = path.join(cell, "Google", "Chrome", "User Data");
    let parent = cell;
    for (const component of ["Google", "Chrome", "User Data", "Default"]) parent = privateDirectory(path.join(parent, component));
    const preferences = path.join(parent, "Preferences");
    const id = "a".repeat(32);
    await fs.writeFile(preferences, JSON.stringify({
      extensions: { settings: { [id]: { from_webstore: true, location: 1, state: 1 } } },
    }));
    grant(preferences, installer);
    if (unsafe) grant(preferences, sid);
    const beforeReads = effects.preferenceReads;
    const discovered = await browser.discoverChromeExtensionIds({ approvedDirs: [], storeExtensionId: id, deps });
    assert.equal(effects.preferenceReads - beforeReads, expectedRefusal ? 0 : 1);
    assert.equal(discovered.storeDiscovered.length, expectedRefusal ? 0 : 1);
    if (expectedRefusal) assert.ok(discovered.issues.some(issue => issue.includes("Refusing unsafe Windows owner or ACL")));
    assert.ok(userData.startsWith(scratch + path.sep));
    records.push({ boundary: "profile-before-read", principal: label, refused: expectedRefusal, preferenceReads: effects.preferenceReads - beforeReads });
  }
  const privateDir = privateDirectory(path.join(scratch, "strict-private"));
  const secret = path.join(privateDir, "secret");
  await fs.writeFile(secret, "synthetic private bytes");
  grant(secret, installer);
  await assert.rejects(readSecureFile({ filePath: secret }), { code: "insecure-permissions" });
  assert.equal(fallbackCalls, 0);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
assert.equal(await exists(scratch), false);
console.log(JSON.stringify({
  evidence: "real-task-owned-Windows-DACL-and-pinned-browser-module",
  node: process.version, arch: process.arch, mode: "require", binarySha256,
  core: { ref, url, sourceSha256, execution: "entire module; TS/import wiring only; existing deps isolation seam" },
  expectedBaselineRejection: values["expect-native-rejection"], fallbackCalls,
  privateServicingWriterRejected: true, scratchRemoved: true, records,
}));
