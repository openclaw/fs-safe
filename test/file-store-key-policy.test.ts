import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { fileStore, fileStoreSync, type FileStore, type FileStoreSync } from "../src/file-store.js";
import { root, type OpenResult } from "../src/root.js";
import { expectFsSafeErrorSync } from "./helpers/security.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const aliases = ["a/../b", "a\\b"];
const fixtures = new Map([
  ["b", Buffer.from('{"sentinel":"normalized-b"}\n')],
  ["a/b", Buffer.from('{"sentinel":"nested-a-b"}\n')],
  ...(process.platform === "win32" ? [] : [
    ["a\\b", Buffer.from('{"sentinel":"literal-backslash"}\n')] as const,
  ]),
]);

async function seedFixtures(): Promise<string> {
  const rootDir = await tempRoot("fs-safe-store-keys-");
  await fs.mkdir(path.join(rootDir, "a"));
  for (const [key, bytes] of fixtures) {
    await fs.writeFile(path.join(rootDir, key), bytes, { mode: 0o600 });
  }
  return rootDir;
}

async function snapshot(directory: string): Promise<Record<string, Buffer | null>> {
  const entries: Record<string, Buffer | null> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries[`${entry.name}/`] = null;
      for (const [key, bytes] of Object.entries(await snapshot(target))) {
        entries[`${entry.name}/${key}`] = bytes;
      }
    } else {
      entries[entry.name] = await fs.readFile(target);
    }
  }
  return entries;
}

async function expectInvalidKey(operation: () => unknown): Promise<void> {
  let result: unknown;
  let error: unknown;
  try {
    result = await operation();
  } catch (reason) {
    error = reason;
  } finally {
    // A regressed open must not leak its returned descriptor when the assertion fails.
    if (result && typeof result === "object" && "handle" in result) {
      await (result as OpenResult).handle.close();
    }
  }
  expect(result).toBeUndefined();
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "invalid-path" });
}

const asyncMethods: Array<{
  name: string;
  run: (store: FileStore, key: string) => unknown;
}> = [
  { name: "path", run: (store, key) => store.path(key) },
  { name: "open", run: (store, key) => store.open(key) },
  { name: "read", run: (store, key) => store.read(key) },
  { name: "readBytes", run: (store, key) => store.readBytes(key) },
  { name: "readText", run: (store, key) => store.readText(key) },
  { name: "readTextIfExists", run: (store, key) => store.readTextIfExists(key) },
  { name: "readJson", run: (store, key) => store.readJson(key) },
  { name: "readJsonIfExists", run: (store, key) => store.readJsonIfExists(key) },
  { name: "exists", run: (store, key) => store.exists(key) },
  { name: "remove", run: (store, key) => store.remove(key) },
  { name: "write", run: (store, key) => store.write(key, Buffer.from("replacement")) },
  { name: "writeText", run: (store, key) => store.writeText(key, "replacement") },
  { name: "writeJson", run: (store, key) => store.writeJson(key, { replacement: true }) },
  { name: "writeStream", run: async (store, key) => {
    const stream = Readable.from(["replacement"]);
    try {
      return await store.writeStream(key, stream);
    } finally {
      stream.destroy();
    }
  } },
  { name: "copyIn", run: (store, key) => store.copyIn(key, path.join(store.rootDir, "b")) },
  { name: "json", run: (store, key) => store.json(key) },
];

const syncMethods: Array<{
  name: string;
  run: (store: FileStoreSync, key: string) => unknown;
}> = [
  { name: "path", run: (store, key) => store.path(key) },
  { name: "readTextIfExists", run: (store, key) => store.readTextIfExists(key) },
  { name: "readJsonIfExists", run: (store, key) => store.readJsonIfExists(key) },
  { name: "write", run: (store, key) => store.write(key, Buffer.from("replacement")) },
  { name: "writeText", run: (store, key) => store.writeText(key, "replacement") },
  { name: "writeJson", run: (store, key) => store.writeJson(key, { replacement: true }) },
];

describe.each([false, true])("FileStore portable keys (private=%s)", (privateMode) => {
  describe.each(aliases)("alias %j", (key) => {
    it.each(asyncMethods)("async $name rejects without disclosing or mutating fixtures", async ({ run }) => {
      const rootDir = await seedFixtures();
      const before = await snapshot(rootDir);
      try {
        await expectInvalidKey(() => run(fileStore({ rootDir, private: privateMode }), key));
      } finally {
        expect(await snapshot(rootDir)).toEqual(before);
      }
    });

    it.each(syncMethods)("sync $name rejects without disclosing or mutating fixtures", async ({ run }) => {
      const rootDir = await seedFixtures();
      const before = await snapshot(rootDir);
      try {
        expectFsSafeErrorSync(() => run(fileStoreSync({ rootDir, private: privateMode }), key), "invalid-path");
      } finally {
        expect(await snapshot(rootDir)).toEqual(before);
      }
    });

    it("preserves missing-root precedence", async () => {
      const base = await tempRoot("fs-safe-store-missing-root-");
      const rootDir = path.join(base, "absent");
      const store = fileStore({ rootDir, private: privateMode });
      await expect(store.readText(key)).rejects.toMatchObject({ code: "not-found" });
      await expect(store.readTextIfExists(key)).resolves.toBeNull();
      await expect(store.readJsonIfExists(key)).resolves.toBeNull();
      await expect(store.exists(key)).rejects.toMatchObject({ code: "not-found" });
      await expect(store.remove(key)).rejects.toMatchObject({ code: "not-found" });
      expectFsSafeErrorSync(() => fileStoreSync({ rootDir }).readTextIfExists(key), "invalid-path");
      expect(await fs.readdir(base)).toEqual([]);
    });
  });

  it("keeps missing leaves distinct from invalid keys", async () => {
    const rootDir = await seedFixtures();
    const store = fileStore({ rootDir, private: privateMode });
    const syncStore = fileStoreSync({ rootDir, private: privateMode });
    await expect(store.readText("absent")).rejects.toMatchObject({ code: "not-found" });
    await expect(store.readTextIfExists("absent")).resolves.toBeNull();
    await expect(store.readJsonIfExists("absent")).resolves.toBeNull();
    await expect(store.exists("absent")).resolves.toBe(false);
    await expect(store.remove("absent")).rejects.toMatchObject({ code: "not-found" });
    expect(syncStore.readTextIfExists("absent")).toBeNull();
    expect(syncStore.readJsonIfExists("absent")).toBeNull();
  });

  it("preserves copy source and JSON serialization ordering", async () => {
    const rootDir = await seedFixtures();
    const before = await snapshot(rootDir);
    const store = fileStore({ rootDir, private: privateMode });
    const syncStore = fileStoreSync({ rootDir, private: privateMode });
    const serializationError = new Error("serialization first");
    const value = { toJSON() { throw serializationError; } };
    for (const key of aliases) {
      await expect(store.copyIn(key, path.join(rootDir, "absent"))).rejects.toMatchObject({
        code: privateMode ? "ENOENT" : "invalid-path",
      });
      await expect(store.writeJson(key, value)).rejects.toBe(serializationError);
      expect(() => syncStore.writeJson(key, value)).toThrow(serializationError);
    }
    expect(await snapshot(rootDir)).toEqual(before);
  });

  it.each(["ordinary/nested.txt", "café/日本語.txt", ".hidden", "a..b", "internal space/a b.txt"])(
    "round-trips accepted key %j through async and sync stores",
    async (key) => {
      const rootDir = await tempRoot("fs-safe-store-key-roundtrip-");
      const store = fileStore({ rootDir, private: privateMode });
      const syncStore = fileStoreSync({ rootDir, private: privateMode });
      const expectedPath = path.join(rootDir, ...key.split("/"));
      expect(store.path(key)).toBe(expectedPath);
      expect(syncStore.path(key)).toBe(expectedPath);
      await expect(store.writeText(key, "async café")).resolves.toBe(expectedPath);
      expect(syncStore.readTextIfExists(key)).toBe("async café");
      expect(syncStore.writeText(key, "sync 日本語")).toBe(expectedPath);
      await expect(store.readText(key)).resolves.toBe("sync 日本語");
      await expect(store.exists(key)).resolves.toBe(true);
      await store.remove(key);
      await expect(store.exists(key)).resolves.toBe(false);
    },
  );

  it.each([false, true])("supports nested NFC JSON helpers (lock=%s)", async (lock) => {
    const rootDir = await tempRoot("fs-safe-store-key-json-");
    const store = fileStore({ rootDir, private: privateMode });
    const state = store.json<{ count: number }>("café/state.json", { lock });
    await expect(state.read()).resolves.toBeUndefined();
    await expect(state.readOr({ count: 0 })).resolves.toEqual({ count: 0 });
    await expect(state.readRequired()).rejects.toMatchObject({ code: "not-found" });
    await expect(state.updateOr({ count: 0 }, (current) => ({ count: current.count + 1 })))
      .resolves.toEqual({ count: 1 });
    await state.write({ count: 2 });
    await expect(state.update((current) => ({ count: current!.count + 1 })))
      .resolves.toEqual({ count: 3 });
    await expect(state.readRequired()).resolves.toEqual({ count: 3 });
    expect(fileStoreSync({ rootDir, private: privateMode }).readJsonIfExists("café/state.json"))
      .toEqual({ count: 3 });
    expect(await fs.readdir(path.dirname(state.filePath))).toEqual(["state.json"]);
  });
});

const invalidKeys = [
  "", " ", " b", "b ", "\tb", "b\n", "\u00a0b",
  ".", "..", "./b", "a/./b", "a/..", "../b", "a/../b", "a/../../b",
  "a//b", "a///b", "a/b/", "a/", "././", "/", "/b", "//server/share/b",
  "a\\b", "a\\/b", "a/b\\c", "\\b", "C:/b", "C:\\b", "\\\\server\\share\\b",
  "\\\\?\\C:\\b", "\\\\?\\UNC\\server\\share\\b", "\\\\.\\C:\\b",
  "C:b", "a/C:b", "a/c:/b", "a/deep/Z:b", "a\0b", "a/b\0",
  "cafe\u0301/b", "a/cafe\u0301", "a./b", "a /b", "a/b.",
  // These formerly took the delegated branch before the remaining canonical checks.
  "a/../cafe\u0301", "a/..//b", "a/../b.", "a\\cafe\u0301", "a\\/./b", "a.\\b",
];

describe("FileStore portable grammar", () => {
  it.each(invalidKeys)("rejects %j through path, read, and mutation validation", async (key) => {
    const rootDir = await seedFixtures();
    const store = fileStore({ rootDir });
    const syncStore = fileStoreSync({ rootDir });
    const before = await snapshot(rootDir);
    try {
      expectFsSafeErrorSync(() => store.path(key), "invalid-path");
      expectFsSafeErrorSync(() => syncStore.path(key), "invalid-path");
      await expectInvalidKey(() => store.readText(key));
      await expectInvalidKey(() => store.writeText(key, "replacement"));
    } finally {
      expect(await snapshot(rootDir)).toEqual(before);
    }
  });

  it("accepts timestamp colons lexically on every platform", async () => {
    const rootDir = await tempRoot("fs-safe-store-timestamp-");
    const key = "logs/2026-08-02T10:30:00Z.log";
    const store = fileStore({ rootDir });
    expect(store.path(key)).toBe(path.join(rootDir, key));
    expect(fileStoreSync({ rootDir }).path(key)).toBe(path.join(rootDir, key));
    if (process.platform !== "win32") {
      await store.writeText(key, "timestamp");
      await expect(store.readText(key)).resolves.toBe("timestamp");
    }
  });

  it("leaves confined existing-object compatibility with Root", async () => {
    const rootDir = await seedFixtures();
    const scoped = await root(rootDir);
    await expect(scoped.readBytes("a/../b")).resolves.toEqual(fixtures.get("b"));
    await expect(scoped.readBytes(path.join(rootDir, "b"))).resolves.toEqual(fixtures.get("b"));
    if (process.platform !== "win32") {
      await expect(scoped.readBytes("a\\b")).resolves.toEqual(fixtures.get("a\\b"));
    }
    const outside = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-outside`);
    await expect(scoped.readText(outside)).rejects.toMatchObject({ code: "outside-workspace" });
    await expect(scoped.readText("../outside")).rejects.toMatchObject({ code: "outside-workspace" });
    await expectInvalidKey(() => fileStore({ rootDir }).readText(path.join(rootDir, "b")));
  });
});
