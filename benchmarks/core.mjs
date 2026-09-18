import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { secureFileBenchmarkCase } from "./secure-file-contract.mjs";
import { applyBenchmarkPrivateWindowsAcl } from "./windows-private-directory.mjs";

export async function registerCore({ api: a, workspace: w, binding, measuredFeatures, register: add, contract, onCleanup }) {
  const data = Buffer.from(' {"ok":true,"label":"synthetic benchmark"}\n');
  const input = path.join(w, "input.json");
  applyBenchmarkPrivateWindowsAcl(a, w);
  fs.writeFileSync(input, data, { mode: 0o600 });
  fs.mkdirSync(path.join(w, "tree", "nested"), { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(w, "tree", `entry-${i}`), data);
  fs.writeFileSync(path.join(w, "tree", "nested", "entry"), data);
  const largeRootRead = Buffer.alloc(1024 * 1024, 120);
  fs.writeFileSync(path.join(w, "root-read-large"), largeRootRead);
  const rootReadCases = [
    { name: "depth=0/tiny", relative: "input.json", payload: data, divisor: 1 },
    { name: "depth=0/large", relative: "root-read-large", payload: largeRootRead, divisor: 10 },
  ];
  for (const depth of [8, 32]) {
    const components = Array.from({ length: depth }, (_, index) => index === 0 ? `root-read-${depth}` : `d${index}`);
    const relativeDir = path.join(...components);
    fs.mkdirSync(path.join(w, relativeDir), { recursive: true });
    for (const [size, payload, divisor] of [["tiny", data, 1], ["large", largeRootRead, 10]]) {
      const relative = path.join(relativeDir, size);
      fs.writeFileSync(path.join(w, relative), payload);
      rootReadCases.push({ name: `depth=${depth}/${size}`, relative, payload, divisor });
    }
  }
  const safe = await a.root(w);
  const directoryStat = fs.lstatSync(w, { bigint: true });
  const directoryIdentity = { dev: directoryStat.dev, ino: directoryStat.ino, realPath: fs.realpathSync.native(w) };
  add("readDirectoryIdentity", () => a.readDirectoryIdentity(w), { verify: (result) => assert.deepEqual(result, directoryIdentity) });
  add("assertDirectoryIdentitySync", () => a.assertDirectoryIdentitySync(w, directoryIdentity), { sync: true });
  const caseInsensitive = fs.existsSync(path.join(w, "INPUT.JSON"));
  add("probePathCaseInsensitiveSync", () => a.probePathCaseInsensitiveSync(input, { allowTemporaryProbe: false }), {
    sync: true, verify: (observed) => assert.equal(observed, caseInsensitive),
  });
  add("probePathSuffixAliasesSync", () => a.probePathSuffixAliasesSync({
    directory: w, left: "Future.sqlite", right: "future.sqlite",
  }), {
    sync: true,
    divisor: 10,
    verify: (observed) => assert.equal(observed, caseInsensitive),
    after: (observed) => assert.equal(observed, caseInsensitive),
    skip: Object.hasOwn(a, "probePathSuffixAliasesSync")
      ? undefined : "The selected distribution does not export probePathSuffixAliasesSync.",
  });
  contract("Root", safe);
  add("root", () => a.root(w));
  for (const name of ["resolve", "read", "readBytes", "readText", "readJson", "exists", "stat"]) {
    add(`Root.${name}`, () => safe[name]("input.json"));
  }
  add("Root.readAbsolute", () => safe.readAbsolute(input));
  add("Root.reader", () => safe.reader(), { sync: true });
  add("Root.reader/call", () => safe.reader()(input));
  add("Root.open", () => safe.open("input.json"), { after: (r) => r?.handle.close() });
  const rootReader = safe.reader({ maxBytes: largeRootRead.length });
  for (const readCase of rootReadCases) {
    add(`Root.open/${readCase.name}`, () => safe.open(readCase.relative), {
      divisor: readCase.divisor,
      after: (result) => result?.handle.close(),
      verify: (result) => assert.equal(result.stat.size, readCase.payload.length),
    });
    add(`Root.read/${readCase.name}`, () => safe.read(readCase.relative, { maxBytes: largeRootRead.length }), {
      divisor: readCase.divisor,
      verify: (result) => assert.deepEqual(result.buffer, readCase.payload),
    });
    add(`Root.reader/call/${readCase.name}`, () => rootReader(readCase.relative), {
      divisor: readCase.divisor,
      verify: (result) => assert.deepEqual(result, readCase.payload),
    });
  }
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
  for (const durable of [true, false]) {
    for (const name of ["write", "writeJson"]) {
      const rel = `root-${name.toLowerCase()}-compatibility.json`;
      const expected = name === "writeJson" ? Buffer.from('{"ok":true}\n') : data;
      add(`Root.${name}/renameIdentity=verify-content-with-lock/durable=${durable}`, () =>
        safe[name](rel, name === "writeJson" ? { ok: true } : data, {
          durable, renameIdentity: "verify-content-with-lock",
        }), {
          divisor: 10,
          verify: () => assert.deepEqual(fs.readFileSync(path.join(w, rel)), expected),
        });
    }
  }
  add("Root.ensureRoot", () => safe.ensureRoot());
  add("Root.remove", () => safe.remove("remove.txt"), { before: () => fs.writeFileSync(path.join(w, "remove.txt"), data) });
  for (const depth of [8, 32]) {
    const segments = [`remove-depth-${depth}`, ...Array.from({ length: depth - 1 }, (_, index) => String(index))];
    const rel = path.join(...segments, "remove.txt");
    const target = path.join(w, rel);
    add(`Root.remove/depth-${depth}`, () => safe.remove(rel), {
      before: () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      },
      verify: () => assert.equal(fs.existsSync(target), false),
    });
  }
  for (const order of ["filesystem", "sorted"]) {
    const rel = `remove-tree-${order}`;
    add(`Root.remove/recursive-${order}`, () => safe.remove(rel, { recursive: true, order, maxEntries: 103 }), {
      divisor: 10,
      before: () => fs.cpSync(path.join(w, "tree"), path.join(w, rel), { recursive: true }),
      verify: () => assert.equal(fs.existsSync(path.join(w, rel)), false),
      after: () => fs.rmSync(path.join(w, rel), { recursive: true, force: true }),
    });
  }
  add("Root.remove/recursive-sorted-unbounded", () => safe.remove("remove-tree-unbounded", {
    recursive: true, order: "sorted", maxEntries: Infinity, maxDepth: Infinity,
  }), {
    divisor: 10,
    before: () => fs.cpSync(path.join(w, "tree"), path.join(w, "remove-tree-unbounded"), { recursive: true }),
    verify: () => assert.equal(fs.existsSync(path.join(w, "remove-tree-unbounded")), false),
    after: () => fs.rmSync(path.join(w, "remove-tree-unbounded"), { recursive: true, force: true }),
  });
  const moveFrom = path.join(w, "move-from");
  const moveTo = path.join(w, "move-to");
  const cleanMoveFixture = () => {
    fs.rmSync(moveFrom, { force: true });
    fs.rmSync(moveTo, { force: true });
  };
  const prepareMoveFixture = () => {
    cleanMoveFixture();
    fs.writeFileSync(moveFrom, data);
  };
  prepareMoveFixture();
  let noReplaceRejectionCode;
  try {
    await safe.move("move-from", "move-to");
  } catch (error) {
    noReplaceRejectionCode = error?.code;
    if (noReplaceRejectionCode !== "helper-unavailable") throw error;
  } finally {
    cleanMoveFixture();
  }
  add("Root.move/overwrite=true", () => safe.move("move-from", "move-to", { overwrite: true }), {
    before: prepareMoveFixture, after: cleanMoveFixture,
  });
  if (noReplaceRejectionCode === undefined) {
    add("Root.move/overwrite=false/success", () => safe.move("move-from", "move-to"), {
      before: prepareMoveFixture, after: cleanMoveFixture,
    });
  } else {
    add("Root.move/overwrite=false/helper-unavailable", () => safe.move("move-from", "move-to"), {
      expectError: true,
      before: prepareMoveFixture,
      verify: (error) => assert.equal(error?.code, "helper-unavailable"),
      after: cleanMoveFixture,
    });
  }
  add("Root.list/names-100", () => safe.list("tree"));
  add("Root.list/metadata-100", () => safe.list("tree", { withFileTypes: true }));
  add("Root.list/names-1", () => safe.list("tree/nested"), {
    verify: names => assert.deepEqual(names, ["entry"]),
  });
  add("Root.list/metadata-1", () => safe.list("tree/nested", { withFileTypes: true }), {
    verify: entries => assert.deepEqual(entries.map(entry => entry.name), ["entry"]),
  });
  add("Root.stat/nested", () => safe.stat("tree/nested/entry"), {
    verify: stat => assert.equal(stat.size, data.length),
  });
  const entryNames = [...Array.from({ length: 100 }, (_, i) => `entry-${i}`), "nested"].sort();
  for (const order of ["filesystem", "sorted"]) {
    add(order === "filesystem" ? "Root.entries" : "Root.entries/sorted", async () => {
      const entries = [];
      for await (const entry of safe.entries("tree", { order, maxEntries: 101 })) entries.push(entry);
      return entries;
    }, { verify: (entries) => assert.deepEqual(order === "sorted" ? entries.map(entry => entry.name) : entries.map(entry => entry.name).sort(), entryNames) });
    add(`Root.entries/first/${order}`, async () => {
      for await (const entry of safe.entries("tree", { order, maxEntries: 101 })) return entry;
    }, { verify: (entry) => {
      assert(entryNames.includes(entry?.name));
      if (order === "sorted") assert.equal(entry.name, entryNames[0]);
    } });
  }
  add("Root.walk", async () => { const entries = []; for await (const entry of safe.walk("tree", { symlinkPolicy: "skip" })) entries.push(entry); return entries; });
  for (const name of ["walkDirectory", "walkDirectorySync"]) add(name, () => a[name](path.join(w, "tree")), { sync: name.endsWith("Sync"), verify: (r) => assert.equal(r.entries.length, 102) });
  add("readLocalFileSafely", () => a.readLocalFileSafely({ filePath: input, maxBytes: 1024 }));
  add("openLocalFileSafely", () => a.openLocalFileSafely({ filePath: input }), { after: (r) => r?.handle.close() });
  add("resolveOpenedFileRealPathForHandle", (h) => a.resolveOpenedFileRealPathForHandle(h, input), { before: () => fsp.open(input, "r"), after: (_, h) => h.close() });
  const { name: secureReadName, ...secureReadOptions } = secureFileBenchmarkCase({
    platform: process.platform, measuredFeatures, binding,
  }, data);
  const secureReadRealPath = fs.realpathSync.native(input);
  const verifyPermissionSkippedSecureRead = (result) => {
    assert.deepEqual(result.buffer, data);
    assert.equal(result.realPath, secureReadRealPath);
    assert.equal(result.permissions, undefined);
  };
  const suppliedSecureReadEnv = {
    SystemRoot: "C:\\fs-safe-benchmark-system-root",
    WINDIR: "C:\\fs-safe-benchmark-windows-dir",
    ...Object.fromEntries(Array.from({ length: 62 }, (_, index) => [
      `FS_SAFE_BENCHMARK_ENV_${index.toString().padStart(2, "0")}`,
      `synthetic-value-${index.toString().padStart(2, "0")}-for-snapshot`,
    ])),
  };
  assert.equal(Object.keys(suppliedSecureReadEnv).length, 64);
  const nonmatchingTrustedDirs = Array.from({ length: 7 }, (_, index) => {
    const directory = path.join(w, `secure-read-nonmatching-root-${index}`);
    fs.mkdirSync(directory);
    return directory;
  });
  const eightTrustedDirs = [...nonmatchingTrustedDirs, w];
  const suppliedEnvSecureReadOptions = {
    filePath: input,
    permissions: { allowInsecure: true },
    inject: { env: suppliedSecureReadEnv },
    io: { maxBytes: 1024 },
  };
  const eightTrustedDirsSecureReadOptions = {
    filePath: input,
    trust: { trustedDirs: eightTrustedDirs },
    permissions: { allowInsecure: true },
    io: { maxBytes: 1024 },
  };
  add(secureReadName, () => a.readSecureFile({ filePath: input, io: { maxBytes: 1024 } }), secureReadOptions);
  add(`${secureReadName}/trusted-root`, () => a.readSecureFile({
    filePath: input, trust: { trustedDirs: [w] }, io: { maxBytes: 1024 },
  }), secureReadOptions);
  add("readSecureFile/permissions-skipped/supplied-env-64", () =>
    a.readSecureFile(suppliedEnvSecureReadOptions), {
    verify: verifyPermissionSkippedSecureRead,
    workloadDetails: { permissionVerification: "skipped", suppliedEnvironmentKeys: 64 },
  });
  add("readSecureFile/permissions-skipped/trusted-roots-8", () =>
    a.readSecureFile(eightTrustedDirsSecureReadOptions), {
    verify: verifyPermissionSkippedSecureRead,
    workloadDetails: { permissionVerification: "skipped", trustedDirectories: 8, nonmatchingDirectories: 7 },
  });
  for (const name of ["readRegularFile", "readRegularFileSync", "statRegularFile", "statRegularFileSync"]) add(name, () => a[name](name.startsWith("stat") ? input : { filePath: input }), { sync: name.endsWith("Sync") });
  for (const name of ["appendRegularFile", "appendRegularFileSync"]) add(name, () => a[name]({ filePath: path.join(w, "append.txt"), content: data }), { sync: name.endsWith("Sync"), before: () => fs.writeFileSync(path.join(w, "append.txt"), data) });
  for (const name of ["openRootFile", "openRootFileSync"]) add(name, () => a[name]({ absolutePath: input, rootPath: w, boundaryLabel: "benchmark" }), { sync: name.endsWith("Sync"), verify: (r) => assert(r.ok), after: (r) => { if (r?.ok) fs.closeSync(r.fd); } });
  for (const name of ["readFileWindowFully", "readFileWindowFullySync"]) {
    const sync = name.endsWith("Sync");
    const buffer = Buffer.alloc(data.length - 1);
    add(name, (opened) => a[name](opened, buffer, 1), {
      sync, before: () => sync ? fs.openSync(input, "r") : fsp.open(input, "r"),
      after: (_, opened) => sync ? fs.closeSync(opened) : opened.close(),
      verify: (count) => { assert.equal(count, buffer.length); assert.deepEqual(buffer, data.subarray(1)); },
    });
  }
  for (const size of [0, 512]) {
    const payload = Buffer.alloc(size, 120);
    const digest = createHash("sha256").update(payload).digest("hex");
    const filePath = path.join(w, `hash-borrowed-${size}`);
    fs.writeFileSync(filePath, payload);
    const fd = fs.openSync(filePath, "r");
    onCleanup(() => fs.closeSync(fd));
    add(`sha256FileSync/borrowed-fd/${size}`, () => a.sha256FileSync(fd), {
      sync: true, batch: 100, verify: (result) => assert.deepEqual(result, { bytes: size, digest }),
    });
  }
  for (const size of [128, 64 * 1024, 1024 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024, 32 * 1024 * 1024]) {
    const divisor = size > 1024 * 1024 ? 10 : 1;
    const filePath = path.join(w, `bytes-${size}`);
    const payload = Buffer.alloc(size, 120);
    const digest = createHash("sha256").update(payload).digest("hex");
    fs.writeFileSync(filePath, payload);
    for (const name of ["readFileDescriptorBounded", "readFileDescriptorBoundedSync", "readFileHandleBounded"]) {
      const handle = name === "readFileHandleBounded";
      add(`${name}/${size}`, (opened) => a[name](opened, size), {
        divisor, sync: name.endsWith("Sync"), before: () => handle ? fsp.open(filePath, "r") : fs.openSync(filePath, "r"),
        after: (_, opened) => handle ? opened.close() : fs.closeSync(opened), verify: (r) => assert.deepEqual(r, payload),
      });
    }
    add(`Root.readBytes/${size}`, () => safe.readBytes(`bytes-${size}`, size > 16 * 1024 * 1024 ? { maxBytes: size } : undefined), { divisor, verify: (r) => assert.deepEqual(r, payload) });
    for (const name of ["sha256File", "sha256FileSync"]) {
      add(`${name}/${size}`, () => a[name](filePath), { divisor, sync: name.endsWith("Sync"), verify: (r) => assert.deepEqual(r, { bytes: size, digest }) });
    }
    const copyPath = path.join(w, `handle-copy-${size}`);
    add(`copyFileHandle/${size}`, ({ source, target }) => a.copyFileHandle(source, target), {
      divisor,
      before: async () => {
        const source = await fsp.open(filePath, "r");
        try { return { source, target: await fsp.open(copyPath, "w+", 0o600) }; }
        catch (error) { await source.close(); throw error; }
      },
      after: (_, { source, target }) => Promise.all([source.close(), target.close()]),
      verify: (bytes) => { assert.equal(bytes, size); assert.deepEqual(fs.readFileSync(copyPath), payload); },
    });
    add(`copyFileDescriptorSync/${size}`, ({ source, target }) => a.copyFileDescriptorSync(source, target), {
      divisor, sync: true,
      skip: typeof a.copyFileDescriptorSync !== "function"
        ? "Not exported by this explicitly selected older comparison build."
        : undefined,
      before: () => {
        const source = fs.openSync(filePath, "r");
        try { return { source, target: fs.openSync(copyPath, "w+", 0o600) }; }
        catch (error) { fs.closeSync(source); throw error; }
      },
      after: (_, { source, target }) => { try { fs.closeSync(source); } finally { fs.closeSync(target); } },
      verify: (bytes) => { assert.equal(bytes, size); assert.deepEqual(fs.readFileSync(copyPath), payload); },
    });
    if (size === 2 * 1024 * 1024) {
      const expectedMinimumChunks = size / (512 * 1024);
      const liveSignal = new AbortController().signal;
      for (const { name, signal, observe, authorize } of [
        { name: "signal", signal: true, observe: false, authorize: false },
        { name: "observer", signal: false, observe: true, authorize: false },
        { name: "authority", signal: false, observe: false, authorize: true },
        { name: "observer+authority", signal: false, observe: true, authorize: true },
        { name: "signal+observer+authority", signal: true, observe: true, authorize: true },
      ]) {
        const callbackCopyPath = path.join(w, `handle-copy-${name}`);
        let observedChunks = 0;
        let observedBytes = 0;
        let authorityCalls = 0;
        const options = {};
        if (signal) options.signal = liveSignal;
        if (observe) options.onChunk = (chunk) => { observedChunks += 1; observedBytes += chunk.byteLength; };
        if (authorize) options.assertBeforeMutation = () => { authorityCalls += 1; };
        add(`copyFileHandle/${name}`, ({ source, target }) => a.copyFileHandle(source, target, options), {
          divisor,
          before: async () => {
            observedChunks = 0;
            observedBytes = 0;
            authorityCalls = 0;
            const source = await fsp.open(filePath, "r");
            try { return { source, target: await fsp.open(callbackCopyPath, "w+", 0o600) }; }
            catch (error) { await source.close(); throw error; }
          },
          after: (_, { source, target }) => Promise.all([source.close(), target.close()]),
          verify: (bytes) => {
            assert.equal(bytes, size);
            if (observe) assert(observedChunks >= expectedMinimumChunks);
            else assert.equal(observedChunks, 0);
            assert.equal(observedBytes, observe ? size : 0);
            if (authorize && observe) assert(authorityCalls >= observedChunks);
            else if (authorize) assert(authorityCalls >= expectedMinimumChunks);
            else assert.equal(authorityCalls, 0);
            assert.deepEqual(fs.readFileSync(callbackCopyPath), payload);
          },
        });
      }
    }
    const overwritePath = path.join(w, `handle-overwrite-${size}`);
    add(`overwriteFileHandle/${size}`, (handle) => a.overwriteFileHandle(handle, payload), {
      divisor,
      before: async () => { await fsp.writeFile(overwritePath, "original", { mode: 0o600 }); return await fsp.open(overwritePath, "r+"); },
      after: (_, handle) => handle.close(),
      verify: () => assert.deepEqual(fs.readFileSync(overwritePath), payload),
    });
    const rootCopyName = `root-copy-${size}`;
    add(`Root.copyIn/${size}/clone=never/durable=false`, () => safe.copyIn(rootCopyName, filePath, {
      clone: "never", durable: false, maxBytes: size,
    }), { divisor, verify: () => assert.deepEqual(fs.readFileSync(path.join(w, rootCopyName)), payload) });
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
