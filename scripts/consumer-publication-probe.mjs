import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { configureFsSafeNative } from "@openclaw/fs-safe";
import { retainEntryForPublication } from "@openclaw/fs-safe/advanced";
import { creationCompiledFiles } from "./consumer-creation-contract.mjs";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";
assert.equal(process.platform, "win32");
configureFsSafeNative({ mode: "require" });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
const require = createRequire(import.meta.url), manifest = require.resolve("@openclaw/fs-safe/package.json");
const binary = createRequire(manifest).resolve(expected.host.package);
assert.equal(hash(fs.readFileSync(binary)), expected.hostBinarySha256);
assert.equal(hash(fs.readFileSync(fileURLToPath(import.meta.url))), expected.publicationProbeSha256);
const compiled = creationCompiledFiles(path.join(path.dirname(manifest), "dist"));
assert.deepEqual(compiled, expected.creation.compiledFiles);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.cwd(), "publication-fixture-")));
const owners = [], rows = [], stat = name => fs.lstatSync(name, { bigint: true });
const input = (source, target) => ({ source: { parent: { path: path.dirname(source), identity: stat(path.dirname(source)) }, basename: path.basename(source),
  expected: { ...stat(source), kind: stat(source).isSymbolicLink() ? "symlink" : stat(source).isDirectory() ? "directory" : "file" } },
  destination: { parent: { path: path.dirname(target), identity: stat(path.dirname(target)) }, basename: path.basename(target) }, assertBeforeMutation() {} });
try {
  const stage = path.join(root, "staging"), target = path.join(root, "checkout"); fs.mkdirSync(stage); fs.mkdirSync(target);
  const checkout = stat(target), payload = path.join(root, "payload"); fs.mkdirSync(payload); fs.writeFileSync(path.join(payload, "bytes"), "external");
  const payloadFile = path.join(root, "payload-file"); fs.writeFileSync(payloadFile, "external file");
  for (const kind of ["file", "directory", "file-relative", "file-absolute", "dir-relative", "dir-absolute", "junction"]) {
    const source = path.join(stage, kind), destination = path.join(target, kind);
    if (kind === "file") fs.writeFileSync(source, "original");
    else if (kind === "directory") { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "bytes"), "original"); }
    else fs.symlinkSync(kind.endsWith("relative") ? `..\\${kind.startsWith("file-") ? "payload-file" : "payload"}` : kind.startsWith("file-") ? payloadFile : payload,
      source, kind === "junction" ? "junction" : kind.startsWith("file-") ? "file" : "dir");
    const original = stat(source), bytes = original.isSymbolicLink() ? fs.readlinkSync(source, { encoding: "buffer" }) : undefined;
    const owner = retainEntryForPublication(input(source, destination)); owners.push(owner);
    const result = owner.publish(); assert.deepEqual(result, { transition: "committed", verification: "verified", resources: "closed", issues: [] });
    assert.equal(stat(destination).ino, original.ino); assert.throws(() => stat(source), { code: "ENOENT" });
    if (bytes) assert.deepEqual(fs.readlinkSync(destination, { encoding: "buffer" }), bytes);
    else assert.equal(fs.readFileSync(kind === "file" ? destination : path.join(destination, "bytes"), "utf8"), "original");
    assert.equal(owner.dispose(), result); rows.push(kind);
  }
  assert.equal(stat(target).ino, checkout.ino); assert.equal(fs.readFileSync(path.join(payload, "bytes"), "utf8"), "external");
  assert.equal(fs.readFileSync(payloadFile, "utf8"), "external file");
  const stageLink = path.join(stage, "runtime"), store = path.join(root, "runtime-store"); fs.symlinkSync(payload, stageLink, "junction");
  const storeOwner = retainEntryForPublication(input(stageLink, store)); owners.push(storeOwner); assert.equal(storeOwner.publish().transition, "committed");
  fs.symlinkSync(payload, stageLink, "junction");
  const collide = retainEntryForPublication(input(stageLink, store)); owners.push(collide); assert.equal(collide.publish().transition, "not-published");
  assert.equal(fs.readlinkSync(store), fs.readlinkSync(stageLink)); assert.equal(stat(target).ino, checkout.ino); rows.push("sibling-store-collision");
  const dispose = retainEntryForPublication(input(stageLink, path.join(target, "unpublished"))); owners.push(dispose);
  assert.deepEqual(dispose.dispose(), { transition: "not-published", verification: "not-performed", resources: "closed", issues: [] });
  assert.equal(fs.readlinkSync(store), fs.readlinkSync(stageLink)); rows.push("close-only");
  assert.equal(nativeBinaryLoaded(binary), true);
  console.log(JSON.stringify({ source: expected.source, rootIntegrity: expected.rootIntegrity, hostBinarySha256: hash(fs.readFileSync(binary)),
    compiledFiles: compiled, nativeLoaded: true, rows }));
} finally { for (const owner of owners) owner.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
