import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.unstubAllEnvs());
const payload = '{"value":"literal"}\n';
const decoy = '{"value":"home"}\n';

async function fixture(key: string, privateMode: boolean, homeInside = false) {
  const base = await tempRoot("fs-safe-store-literal-probe-");
  const rootDir = path.join(base, "store");
  const syntheticHome = path.join(homeInside ? rootDir : base, "synthetic-home");
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(syntheticHome, { recursive: true, mode: 0o700 });
  // Scoped test fixture, restored after each test; no host-home I/O occurs.
  vi.stubEnv("HOME", syntheticHome);
  const store = fileStore({ rootDir, private: privateMode, durable: false });
  const sync = fileStoreSync({ rootDir, private: privateMode, durable: false });
  const literalPath = path.join(rootDir, ...key.split("/"));
  const homePath = key === "~" ? syntheticHome : path.join(syntheticHome, key.slice(2));
  return { rootDir, syntheticHome, homePath, literalPath, store, sync };
}

async function observe(run: () => unknown): Promise<unknown> {
  try { return { ok: true, value: await run() }; }
  catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? (error as Error).name };
  }
}

async function readOrMissing(filePath: string): Promise<string | null> {
  try { return await fs.readFile(filePath, "utf8"); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
}

describe.each([false, true])("literal FileStore keys (private=%s)", privateMode => {
  it.each(["~", "~/value.json", "ordinary/value.json", "nested/~/value.json", "~other/value.json"])(
    "all read surfaces use the canonical key %j", async key => {
      const f = await fixture(key, privateMode);
      expect(f.store.path(key)).toBe(f.literalPath);
      expect(f.sync.writeText(key, payload)).toBe(f.literalPath);
      expect(f.sync.readTextIfExists(key)).toBe(payload);
      const reads = {
        open: () => f.store.open(key).then(async opened => {
          try { return await opened.handle.readFile("utf8"); }
          finally { await opened.handle.close(); }
        }),
        read: () => f.store.read(key).then(result => result.buffer.toString("utf8")),
        readBytes: () => f.store.readBytes(key).then(result => result.toString("utf8")),
        readText: () => f.store.readText(key),
        readTextIfExists: () => f.store.readTextIfExists(key),
        readJson: () => f.store.readJson(key),
        readJsonIfExists: () => f.store.readJsonIfExists(key),
        jsonRead: () => f.store.json(key).read(),
        jsonReadRequired: () => f.store.json(key).readRequired(),
        exists: () => f.store.exists(key),
      };
      const actual: Record<string, unknown> = {};
      for (const [name, run] of Object.entries(reads)) actual[name] = await observe(run);
      const scoped = await root(f.rootDir);
      expect(await scoped.readText(`./${key}`)).toBe(payload);
      const expected: Record<string, unknown> = {};
      for (const name of Object.keys(reads)) expected[name] = { ok: true,
        value: name === "exists" ? true : name.toLowerCase().includes("json") ? { value: "literal" } : payload };
      expect(actual).toEqual(expected);
    },
  );

  it.each(["~", "~/value.json", "ordinary/value.json"])("writes select the literal destination %j", async key => {
    const results: Record<string, unknown> = {};
    for (const method of ["write", "writeStream", "copyIn", "jsonWrite"] as const) {
      const f = await fixture(key, privateMode);
      const sourcePath = path.join(path.dirname(f.rootDir), "source.json");
      await fs.writeFile(sourcePath, payload, { mode: 0o600 });
      const run = method === "write" ? () => f.store.write(key, payload)
        : method === "writeStream" ? () => f.store.writeStream(key, Readable.from([payload]))
        : method === "copyIn" ? () => f.store.copyIn(key, sourcePath)
        : () => f.store.json(key).write({ value: "literal" });
      const operation = await observe(async () => { await run(); return "written"; });
      const literalText = await readOrMissing(f.literalPath);
      results[method] = { operation, literalText: literalText === null ? null : JSON.parse(literalText) };
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(results).map(method => [method,
      { operation: { ok: true, value: "written" }, literalText: { value: "literal" } }])));
  });

  it("does not read, overwrite, or delete an in-root home peer for ~/value.json", async () => {
    const key = "~/value.json";
    const f = await fixture(key, privateMode, true);
    f.sync.writeText(key, payload);
    await fs.writeFile(f.homePath, decoy, { mode: 0o600 });
    const scoped = await root(f.rootDir);
    expect(await scoped.readText(key)).toBe(decoy);
    expect(await scoped.readText(`./${key}`)).toBe(payload);
    const read = await observe(() => f.store.readText(key));
    const jsonRead = await observe(() => f.store.json(key).readRequired());
    const write = await observe(async () => (await f.store.writeText(key, '{"value":"replacement"}\n')) === f.literalPath);
    const afterWrite = { literal: await readOrMissing(f.literalPath), peer: await readOrMissing(f.homePath) };
    const remove = await observe(async () => { await f.store.remove(key); return "removed"; });
    const afterRemove = { literal: await readOrMissing(f.literalPath), peer: await readOrMissing(f.homePath) };
    expect({ read, jsonRead, write, afterWrite, remove, afterRemove }).toEqual({
      read: { ok: true, value: payload }, jsonRead: { ok: true, value: { value: "literal" } },
      write: { ok: true, value: true },
      afterWrite: { literal: '{"value":"replacement"}\n', peer: decoy },
      remove: { ok: true, value: "removed" }, afterRemove: { literal: null, peer: decoy },
    });
  });

  it("removes a literal root file named ~ while preserving the synthetic home directory", async () => {
    const f = await fixture("~", privateMode, true);
    f.sync.writeText("~", payload);
    const removal = await observe(async () => { await f.store.remove("~"); return "removed"; });
    const actual = { removal, literal: await readOrMissing(f.literalPath),
      homeExists: await fs.stat(f.syntheticHome).then(() => true, () => false) };
    expect(actual).toEqual({ removal: { ok: true, value: "removed" }, literal: null, homeExists: true });
  });

  it.each(["~", "~/state.json"])("keeps JSON updates on literal key %j with a sidecar lock", async key => {
    const f = await fixture(key, privateMode);
    const state = f.store.json<{ count: number }>(key, { lock: true });
    expect(state.filePath).toBe(f.literalPath);
    await expect(state.read()).resolves.toBeUndefined();
    await expect(state.updateOr({ count: 0 }, current => ({ count: current.count + 1 })))
      .resolves.toEqual({ count: 1 });
    await expect(state.update(current => ({ count: current!.count + 1 })))
      .resolves.toEqual({ count: 2 });
    expect(f.sync.readJsonIfExists(key)).toEqual({ count: 2 });
    expect(await fs.readdir(path.dirname(f.literalPath))).toEqual([path.basename(f.literalPath)]);
  });
});

it.each(["~", "~/value.json"])("prune removes expired literal file %j without deleting its fresh home peer", async key => {
  const f = await fixture(key, false, true);
  const peer = key === "~" ? path.join(f.syntheticHome, "value.json") : f.homePath;
  f.sync.writeText(key, payload);
  await fs.writeFile(peer, decoy, { mode: 0o600 });
  const old = new Date(Date.now() - 120_000);
  await fs.utimes(f.literalPath, old, old);
  await f.store.pruneExpired({ ttlMs: 60_000, recursive: true });
  const actual = { literal: await readOrMissing(f.literalPath), freshPeer: await readOrMissing(peer) };
  expect(actual).toEqual({ literal: null, freshPeer: decoy });
});

it.each(["~", "~/empty"])("prune removes empty literal directory %j without removing home", async key => {
  const f = await fixture(key, false, true);
  await fs.mkdir(f.literalPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(f.syntheticHome, "fresh.json"), decoy, { mode: 0o600 });
  await f.store.pruneExpired({ ttlMs: 60_000, recursive: true, pruneEmptyDirs: true });
  await expect(fs.stat(path.join(f.rootDir, "~"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(f.syntheticHome, "fresh.json"), "utf8")).toBe(decoy);
});
