// Minimal ordinary-Node comparisons; these are not equivalent security implementations.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { create as createTar, extract as extractTar } from "tar";
import { applyBenchmarkPrivateWindowsAcl } from "./windows-private-directory.mjs";

export async function nodeBaselineCases(api, workspace, filter = "") {
  applyBenchmarkPrivateWindowsAcl(api, workspace);
  const p = (name) => path.join(workspace, name);
  const data = Buffer.from('{"ok":true,"count":42}\n');
  const json = JSON.parse(data);
  fs.writeFileSync(p("input"), data);
  fs.mkdirSync(p("private"), { mode: 0o700 });
  fs.writeFileSync(p("private/state"), data, { mode: 0o600 });
  const root = await api.root(workspace);
  const store = api.jsonStore({ filePath: p("private/state"), durable: false });
  const cases = [];
  const add = (operation, safe, raw, caveat, options = {}) => {
    if (!operation.includes(filter)) return;
    cases.push({ operation, safe, raw, caveat, ...options });
  };
  const bytes = (result) => assert.deepEqual(result, data);
  const content = (name, expected = data) => () => assert.deepEqual(fs.readFileSync(p(name)), expected);
  const absent = (name) => () => assert.equal(fs.existsSync(p(name)), false);
  const readCaveat = "Node reads a trusted path; fs-safe additionally validates confinement and file identity.";
  add("read", () => root.readBytes("input"), () => fsp.readFile(p("input")), readCaveat, { verify: bytes });
  add("read-sync", () => api.readRegularFileSync({ filePath: p("input") }).buffer,
    () => fs.readFileSync(p("input")), "Standalone readRegularFileSync versus readFileSync; regular-file and identity checks are extra.", { sync: true, verify: bytes });
  const verifyJson = (result) => assert.deepEqual(result, json);
  add("readJson", () => root.readJson("input"), async () => JSON.parse(await fsp.readFile(p("input"), "utf8")), readCaveat, { verify: verifyJson });
  add("readJson-sync", () => api.readJsonSync(p("input")), () => JSON.parse(fs.readFileSync(p("input"), "utf8")), readCaveat, { sync: true, verify: verifyJson });
  add("A/A-read", () => fsp.readFile(p("input")), () => fsp.readFile(p("input")),
    "Noise control: both arms are the same ordinary Node readFile, not fs-safe.", { verify: bytes, control: true });
  for (const durable of [true, false]) {
    const caveat = `Node truncates in place${durable ? " and fsyncs the file once" : " without fsync"}; fs-safe stages and atomically renames${durable ? ", also synchronizing publication where supported" : " without durability sync"}.`;
    const write = async () => {
      const handle = await fsp.open(p("output"), "w", 0o600);
      try { await handle.writeFile(data); if (durable) await handle.sync(); }
      finally { await handle.close(); }
    };
    const writeSync = () => {
      const fd = fs.openSync(p("output"), "w", 0o600);
      try { fs.writeFileSync(fd, data); if (durable) fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    };
    const before = () => fs.writeFileSync(p("output"), data);
    add(`write-${durable}`, () => root.write("output", data, { durable }), write, caveat,
      { before, verify: content("output") });
    add(`write-sync-${durable}`, () => api.replaceFileAtomicSync({ filePath: p("output"), content: data, syncTempFile: durable, syncParentDir: durable }),
      writeSync, "Standalone replaceFileAtomicSync. " + caveat, { sync: true, before, verify: content("output") });
  }
  add("create", () => root.create("new", data, { durable: false }), () => fsp.writeFile(p("new"), data, { flag: "wx" }),
    "Exclusive creation; fs-safe adds guarded atomic publication. Durability disabled.",
    { before: () => fs.rmSync(p("new"), { force: true }), verify: content("new") });
  add("create-sync", () => {
    const handle = api.createFileSync(p("new-sync"));
    try { fs.writeFileSync(handle.fd, data); } finally { handle.close(); }
  }, () => fs.writeFileSync(p("new-sync"), data, { flag: "wx" }),
  "Standalone createFileSync plus writing and closing the owned descriptor versus exclusive writeFileSync.",
  { sync: true, before: () => fs.rmSync(p("new-sync"), { force: true }), verify: content("new-sync") });
  add("append", () => root.append("append", data, { durable: false }), () => fsp.appendFile(p("append"), data),
    "Node appendFile versus guarded append; durability disabled.",
    { before: () => fs.writeFileSync(p("append"), data), verify: content("append", Buffer.concat([data, data])) });
  add("copyIn", () => root.copyIn("copy", p("input"), { durable: false }), () => fsp.copyFile(p("input"), p("copy")),
    "Existing destination; Node copyFile versus guarded staged copy with identity checks. Durability disabled.",
    { before: () => fs.writeFileSync(p("copy"), data), verify: content("copy") });
  add("copyRootFileSync", () => api.copyRootFileSync({ source: { rootPath: workspace, absolutePath: p("input") },
    destination: { rootPath: workspace, absolutePath: p("copy") } }),
  () => fs.copyFileSync(p("input"), p("copy"), fs.constants.COPYFILE_EXCL),
  "Absent destination; exclusive Node copy versus guarded copy retaining an owned descriptor. Descriptor close is outside timing.",
  { sync: true, before: () => fs.rmSync(p("copy"), { force: true }), verify: content("copy"), after: (result) => result?.close() });
  add("remove", () => root.remove("remove"), () => fsp.unlink(p("remove")),
    "Single regular file; unlink versus guarded removal.", { before: () => fs.writeFileSync(p("remove"), data), verify: absent("remove") });
  add("move", () => root.move("from", "to", { overwrite: true }), () => fsp.rename(p("from"), p("to")),
    "Same-directory overwrite rename versus guarded move.", { before: () => { fs.writeFileSync(p("from"), data); fs.writeFileSync(p("to"), data); },
      verify: () => { absent("from")(); content("to")(); } });
  for (const sync of [false, true]) {
    add(`mkdir${sync ? "-sync" : ""}`, sync ? () => api.createDirectorySync(p("new-dir")) : () => root.mkdir("new-dir"),
      sync ? () => fs.mkdirSync(p("new-dir")) : () => fsp.mkdir(p("new-dir")),
      `${sync ? "Standalone createDirectorySync" : "Root.mkdir"} versus ordinary mkdir in an existing parent; guarded ancestry and identity checks are extra.`,
      { sync, verify: () => assert(fs.statSync(p("new-dir")).isDirectory()), after: () => fs.rmdirSync(p("new-dir")) });
  }
  for (const count of [1000, 50000]) {
    const rel = `tree-${count}`;
    if (!["list", "walk", "walkDirectory", "walkDirectorySync"].some((name) => `${name}-${count}`.includes(filter))) continue;
    fs.mkdirSync(p(rel));
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(p(rel), String(i)), "");
    const verify = (result) => assert.equal(typeof result === "number" ? result : (Array.isArray(result) ? result : result.entries).length, count);
    const iterations = count === 1000 ? 5 : 1;
    add(`list-${count}`, () => root.list(rel), () => fsp.readdir(p(rel)),
      "Flat directory; Node returns unsorted names; Root also sorts and validates names and confinement.", { iterations, verify });
    add(`walk-${count}`, async () => { let n = 0; for await (const _entry of root.walk(rel, { symlinkPolicy: "skip" })) n++; return n; },
      async () => { let n = 0; for (const entry of await fsp.readdir(p(rel), { withFileTypes: true })) { fs.lstatSync(path.join(p(rel), entry.name)); n++; } return n; },
      "Flat tree; raw Dirents plus lstatSync per file for size metadata versus Root's confined metadata walk.", { iterations, verify });
    for (const sync of [false, true]) {
      add(`walkDirectory${sync ? "Sync" : ""}-${count}`, () => api[sync ? "walkDirectorySync" : "walkDirectory"](p(rel)),
        () => sync ? fs.readdirSync(p(rel), { withFileTypes: true }) : fsp.readdir(p(rel), { withFileTypes: true }),
        "Flat tree; raw Dirents versus standalone guarded directory walk (no recursive-directory workload).", { sync, iterations, verify });
    }
  }
  const digest = createHash("sha256").update(data).digest("hex");
  for (const sync of [false, true]) {
    add(`hash${sync ? "-sync" : ""}`, () => api[sync ? "sha256FileSync" : "sha256File"](p("input")),
      sync ? () => createHash("sha256").update(fs.readFileSync(p("input"))).digest("hex") : async () => createHash("sha256").update(await fsp.readFile(p("input"))).digest("hex"),
      "23-byte file; Node reads all bytes then hashes; fs-safe streams/hashes with file checks.",
      { sync, verify: (result) => assert.equal(typeof result === "string" ? result : result.digest, digest) });
  }
  add("json-store-read", () => store.read(), async () => JSON.parse(await fsp.readFile(p("private/state"), "utf8")),
    "Private existing JSON file; fs-safe additionally checks permissions and file identity.", { verify: verifyJson });
  add("json-store-update", () => store.update((value) => value), async () => {
    const value = JSON.parse(await fsp.readFile(p("private/state"), "utf8"));
    await fsp.writeFile(p("private/state"), JSON.stringify(value));
  }, "No-op value update; Node read/parse/stringify/truncate versus locked atomic JSON update. Durability disabled.",
  { verify: () => verifyJson(JSON.parse(fs.readFileSync(p("private/state"), "utf8"))) });
  const lockOptions = { payload: () => ({ pid: process.pid }), timeoutMs: 1000 };
  for (const sync of [false, true]) {
    const suffix = sync ? "-sync" : "";
    const acquire = () => api[sync ? "acquireFileLockSync" : "acquireFileLock"](p("resource"), lockOptions);
    const rawAcquire = sync ? () => fs.openSync(p("raw.lock"), "wx") : () => fsp.open(p("raw.lock"), "wx");
    const rawRelease = sync ? (fd) => { fs.closeSync(fd); fs.unlinkSync(p("raw.lock")); }
      : async (handle) => { await handle.close(); await fsp.unlink(p("raw.lock")); };
    add(`lock-acquire${suffix}`, acquire, rawAcquire,
      "Uncontended existing parent; Node exclusive open only, no owner record or fsync; fs-safe adds ownership/recovery protocol (sync acquisition fsyncs). Release excluded.",
      { sync, verify: (_, role) => assert(fs.existsSync(p(role === "safe" ? "resource.lock" : "raw.lock"))),
        after: (result, role) => role === "safe" ? result.release() : rawRelease(result) });
    add(`lock-release${suffix}`, (handle) => handle.release(), rawRelease,
      "Close/unlink of an already acquired lock; Node lacks ownership verification. Acquisition excluded.",
      { sync, before: (role) => role === "safe" ? acquire() : rawAcquire(),
        verify: (_, role) => absent(role === "safe" ? "resource.lock" : "raw.lock")() });
    const tempOptions = { rootDir: p("private"), prefix: "w-", cleanupSafety: "compatible" };
    const tempCreate = () => api[sync ? "tempWorkspaceSync" : "tempWorkspace"](tempOptions);
    const rawTemp = sync ? () => fs.mkdtempSync(p("private/w-")) : () => fsp.mkdtemp(p("private/w-"));
    const rawCleanup = sync ? (dir) => fs.rmdirSync(dir) : (dir) => fsp.rmdir(dir);
    add(`temp-create${suffix}`, tempCreate, rawTemp,
      "Empty workspace under an existing private parent; Node mkdtemp versus owned workspace with ancestry checks. Cleanup excluded.",
      { sync, verify: (result, role) => assert(fs.statSync(role === "safe" ? result.dir : result).isDirectory()),
        after: (result, role) => role === "safe" ? result.cleanup() : rawCleanup(result) });
    add(`temp-cleanup${suffix}`, (temp) => temp.cleanup(), rawCleanup,
      "Empty workspace; Node rmdir versus guarded ownership, quarantine and bounded cleanup (compatible safety). Creation excluded.",
      { sync, before: (role) => role === "safe" ? tempCreate() : rawTemp(),
        verify: (_, role, input) => assert(!fs.existsSync(role === "safe" ? input.dir : input)) });
  }
  for (const kind of ["zip", "tar"]) {
    if (!`extract-${kind}`.includes(filter)) continue;
    const source = p(`archive-${kind}`);
    fs.mkdirSync(source);
    const names = Array.from({ length: 10 }, (_, i) => `file-${i}.json`);
    const zip = new JSZip();
    for (const name of names) { fs.writeFileSync(path.join(source, name), data); zip.file(name, data); }
    const archivePath = p(`fixture.${kind}`);
    if (kind === "zip") fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
    else await createTar({ cwd: source, file: archivePath, portable: true, noMtime: true }, names);
    const destDir = p(`extract-${kind}`);
    const raw = kind === "tar" ? () => extractTar({ file: archivePath, cwd: destDir }) : async () => {
      const loaded = await JSZip.loadAsync(await fsp.readFile(archivePath));
      for (const name of names) await fsp.writeFile(path.join(destDir, name), await loaded.file(name).async("nodebuffer"));
    };
    add(`extract-${kind}`, () => api.extractArchive({ archivePath, destDir, kind, durable: false }), raw,
      `Ten flat 23-byte files; ${kind === "zip" ? "JSZip load/decode plus Node writes" : "tar package extract"} versus guarded extraction. No native Node archive API; trusted synthetic names only; durability disabled.`,
      { iterations: 2, before: () => fs.mkdirSync(destDir), verify: () => {
        assert.deepEqual(fs.readdirSync(destDir).sort(), names.slice().sort());
        for (const name of names) assert.deepEqual(fs.readFileSync(path.join(destDir, name)), data);
      }, after: () => fs.rmSync(destDir, { recursive: true }) });
  }
  return cases;
}
