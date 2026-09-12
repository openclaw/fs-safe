import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export async function registerCore({ api: a, workspace: w, register: add, contract }) {
  const data = Buffer.from(' {"ok":true,"label":"synthetic benchmark"}\n');
  const input = path.join(w, "input.json");
  fs.writeFileSync(input, data, { mode: 0o600 });
  fs.mkdirSync(path.join(w, "tree", "nested"), { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(w, "tree", `entry-${i}`), data);
  fs.writeFileSync(path.join(w, "tree", "nested", "entry"), data);
  const safe = await a.root(w);
  contract("Root", safe);
  add("root", () => a.root(w));
  for (const name of ["resolve", "read", "readBytes", "readText", "readJson", "exists", "stat"]) {
    add(`Root.${name}`, () => safe[name]("input.json"));
  }
  add("Root.readAbsolute", () => safe.readAbsolute(input));
  add("Root.reader", () => safe.reader(), { sync: true });
  add("Root.reader/call", () => safe.reader()(input));
  add("Root.open", () => safe.open("input.json"), { after: (r) => r?.handle.close() });
  add("OpenResult.[Symbol.asyncDispose]", (r) => r[Symbol.asyncDispose](), { before: () => safe.open("input.json") });
  contract("OpenResult", await (async () => { const r = await safe.open("input.json"); await r.handle.close(); return r; })());
  add("Root.openWritable", () => safe.openWritable("writable.txt"), { after: (r) => r?.handle.close() });
  const writable = await safe.openWritable("writable.txt");
  contract("WritableOpenResult", writable);
  await writable.handle.close();
  add("WritableOpenResult.[Symbol.asyncDispose]", (r) => r[Symbol.asyncDispose](), { before: () => safe.openWritable("writable.txt") });
  for (const durable of [true, false]) {
    for (const name of ["write", "writeJson", "append", "copyIn", "create", "createJson"]) {
      const rel = `root-${name}.json`;
      const exclusive = name.startsWith("create");
      add(`Root.${name}/durable=${durable}`, () => safe[name](rel, name.endsWith("Json") ? { ok: true } : name === "copyIn" ? input : data, { durable }), {
        before: exclusive ? () => fs.rmSync(path.join(w, rel), { force: true })
          : name === "append" ? () => fs.writeFileSync(path.join(w, rel), data) : undefined,
      });
    }
  }
  add("Root.mkdir", () => safe.mkdir("new-dir"), { after: () => fs.rmdirSync(path.join(w, "new-dir")) });
  add("Root.ensureRoot", () => safe.ensureRoot());
  add("Root.remove", () => safe.remove("remove.txt"), { before: () => fs.writeFileSync(path.join(w, "remove.txt"), data) });
  add("Root.move", () => safe.move("move-from", "move-to"), {
    before: () => fs.writeFileSync(path.join(w, "move-from"), data), after: () => fs.rmSync(path.join(w, "move-to"), { force: true }),
  });
  add("Root.list/names-100", () => safe.list("tree"));
  add("Root.list/metadata-100", () => safe.list("tree", { withFileTypes: true }));
  add("Root.walk", async () => { const entries = []; for await (const entry of safe.walk("tree", { symlinkPolicy: "skip" })) entries.push(entry); return entries; });
  for (const name of ["walkDirectory", "walkDirectorySync"]) add(name, () => a[name](path.join(w, "tree")), { sync: name.endsWith("Sync"), verify: (r) => assert.equal(r.entries.length, 102) });
  add("readLocalFileSafely", () => a.readLocalFileSafely({ filePath: input, maxBytes: 1024 }));
  add("openLocalFileSafely", () => a.openLocalFileSafely({ filePath: input }), { after: (r) => r?.handle.close() });
  add("resolveOpenedFileRealPathForHandle", (h) => a.resolveOpenedFileRealPathForHandle(h, input), { before: () => fsp.open(input, "r"), after: (_, h) => h.close() });
  add("readSecureFile", () => a.readSecureFile({ filePath: input, io: { maxBytes: 1024 } }));
  for (const name of ["readRegularFile", "readRegularFileSync", "statRegularFile", "statRegularFileSync"]) add(name, () => a[name](name.startsWith("stat") ? input : { filePath: input }), { sync: name.endsWith("Sync") });
  for (const name of ["appendRegularFile", "appendRegularFileSync"]) add(name, () => a[name]({ filePath: path.join(w, "append.txt"), content: data }), { sync: name.endsWith("Sync"), before: () => fs.writeFileSync(path.join(w, "append.txt"), data) });
  for (const name of ["openRootFile", "openRootFileSync"]) add(name, () => a[name]({ absolutePath: input, rootPath: w, boundaryLabel: "benchmark" }), { sync: name.endsWith("Sync"), verify: (r) => assert(r.ok), after: (r) => { if (r?.ok) fs.closeSync(r.fd); } });
  for (const size of [128, 64 * 1024, 1024 * 1024]) {
    const filePath = path.join(w, `bytes-${size}`);
    const payload = Buffer.alloc(size, 120);
    fs.writeFileSync(filePath, payload);
    for (const name of ["readFileDescriptorBounded", "readFileDescriptorBoundedSync", "readFileHandleBounded"]) {
      const handle = name === "readFileHandleBounded";
      add(`${name}/${size}`, (opened) => a[name](opened, size), {
        sync: name.endsWith("Sync"), before: () => handle ? fsp.open(filePath, "r") : fs.openSync(filePath, "r"),
        after: (_, opened) => handle ? opened.close() : fs.closeSync(opened), verify: (r) => assert.deepEqual(r, payload),
      });
    }
    add(`Root.readBytes/${size}`, () => safe.readBytes(`bytes-${size}`), { verify: (r) => assert.deepEqual(r, payload) });
    add(`sha256File/${size}`, () => a.sha256File(filePath), { verify: (r) => assert.equal(r.bytes, size) });
  }
  for (const name of ["tryReadJson", "tryReadJsonSync", "readJson", "readJsonSync", "readJsonIfExists"]) add(name, () => a[name](input), { sync: name.endsWith("Sync"), verify: (r) => assert.equal(r.ok, true) });
  for (const name of ["readRootJsonSync", "readRootJsonObjectSync", "readRootStructuredFileSync"]) add(name, () => a[name]({ rootDir: w, relativePath: "input.json", boundaryLabel: "benchmark", parse: JSON.parse }), { sync: true, verify: (r) => assert(r.ok) });
  for (const name of ["writeJson", "writeJsonSync"]) add(name, () => a[name](path.join(w, `${name}.json`), { ok: true }), { sync: name.endsWith("Sync"), divisor: 10 });
  add("JsonFileReadError", () => new a.JsonFileReadError("synthetic.json", "parse", new Error("fixture")), { sync: true });
  for (const name of ["readSecretFile", "readSecretFileSync", "tryReadSecretFile", "tryReadSecretFileSync"]) add(name, () => a[name](input, "benchmark"), { sync: name.endsWith("Sync") });
  for (const name of ["fileStore", "fileStoreSync"]) {
    add(name, () => a[name]({ rootDir: w }), { sync: true });
    const store = a[name]({ rootDir: w });
    const type = name === "fileStore" ? "FileStore" : "FileStoreSync";
    contract(type, store);
    const sync = name.endsWith("Sync");
    add(`${type}.path`, () => store.path("input.json"), { sync: true });
    for (const method of ["readTextIfExists", "readJsonIfExists", ...(sync ? [] : ["read", "readBytes", "readText", "readJson", "exists"])]) add(`${type}.${method}`, () => store[method]("input.json"), { sync });
    for (const durable of [true, false]) for (const method of ["write", "writeText", "writeJson"]) add(`${type}.${method}/durable=${durable}`, () => store[method](`store-${method}.json`, method === "writeJson" ? { ok: true } : data, { durable }), { sync, divisor: 10, before: () => {} });
    if (sync) continue;
    add(`${type}.root`, () => store.root());
    add(`${type}.open`, () => store.open("input.json"), { after: (r) => r?.handle.close() });
    add(`${type}.remove`, () => store.remove("store-remove"), { before: () => fs.writeFileSync(path.join(w, "store-remove"), data) });
    add(`${type}.json`, () => store.json("input.json"), { sync: true });
    add(`${type}.pruneExpired`, () => store.pruneExpired({ ttlMs: 24 * 3600_000 }));
    add(`${type}.copyIn`, () => store.copyIn("store-copy", input));
    add(`${type}.writeStream`, (stream) => store.writeStream("store-stream", stream), { before: () => Readable.from([data]) });
  }
  add("jsonStore", () => a.jsonStore({ filePath: input }), { sync: true });
  const json = a.jsonStore({ filePath: path.join(w, "document.json"), durable: false });
  contract("JsonStore", json);
  await json.write({ ok: true });
  for (const name of ["read", "readOr", "readRequired"]) add(`JsonStore.${name}`, () => json[name]({ ok: false }));
  add("JsonStore.write", () => json.write({ ok: true }));
  add("JsonStore.update", () => json.update((value) => value));
  add("JsonStore.updateOr", () => json.updateOr({ ok: true }, (value) => value));
  return () => {};
}
