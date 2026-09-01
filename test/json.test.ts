import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { createAsyncLock } from "../src/async-lock.js";
import { writeTextAtomic } from "../src/atomic.js";
import { FsSafeError } from "../src/errors.js";
import {
  JsonFileReadError,
  readRootJsonObjectSync,
  readRootStructuredFileSync,
  readJson,
  readJsonIfExists,
  readJsonSync,
  tryReadJson,
  writeJson,
  writeJsonSync,
} from "../src/json.js";

const { tempRoot } = useTempDirs();



function mockOpenForSyncCounting(): { readonly syncCalls: number; restore: () => void } {
  let syncCalls = 0;
  const realOpen = fs.open.bind(fs);
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === "sync") {
          return async () => {
            syncCalls += 1;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  return {
    get syncCalls() {
      return syncCalls;
    },
    restore: () => openSpy.mockRestore(),
  };
}

describe("json file helpers", () => {
  it("writes formatted JSON atomically with an optional trailing newline", async () => {
    const root = await tempRoot("fs-safe-json-");
    const filePath = path.join(root, "nested", "state.json");

    await writeJson(filePath, { ok: true }, { mode: 0o600, trailingNewline: true });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{\n  \"ok\": true\n}\n");
    await expect(tryReadJson(filePath)).resolves.toEqual({ ok: true });
    await expect(readJson(filePath)).resolves.toEqual({ ok: true });
  });

  it("uses dirMode and trailingNewline consistently for text writes", async () => {
    const root = await tempRoot("fs-safe-json-");
    const filePath = path.join(root, "nested", "note.txt");

    await writeTextAtomic(filePath, "hello", {
      dirMode: 0o700,
      mode: 0o600,
      trailingNewline: true,
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("hello\n");
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(filePath));
      const fileStat = await fs.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it("syncs temp file and parent directory by default for text writes", async () => {
    const root = await tempRoot("fs-safe-json-");
    const filePath = path.join(root, "default-durable.txt");
    const syncCounter = mockOpenForSyncCounting();

    try {
      await writeTextAtomic(filePath, "data");
    } finally {
      syncCounter.restore();
    }

    expect(syncCounter.syncCalls).toBe(2);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("data");
  });

  it("skips fsync when text writes opt out of durability", async () => {
    const root = await tempRoot("fs-safe-json-");
    const filePath = path.join(root, "store.json");
    await fs.writeFile(filePath, "old", "utf8");
    const syncCounter = mockOpenForSyncCounting();

    try {
      await writeTextAtomic(filePath, "new", { durable: false });
    } finally {
      syncCounter.restore();
    }

    expect(syncCounter.syncCalls).toBe(0);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
    const dirEntries = await fs.readdir(root);
    expect(dirEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("threads durable option through JSON writes", async () => {
    const root = await tempRoot("fs-safe-json-");
    const filePath = path.join(root, "state.json");
    const syncCounter = mockOpenForSyncCounting();

    try {
      await writeJson(filePath, { ok: true }, { durable: false });
    } finally {
      syncCounter.restore();
    }

    expect(syncCounter.syncCalls).toBe(0);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{\n  \"ok\": true\n}");
  });

  it("separates nullable and durable read failure semantics", async () => {
    const root = await tempRoot("fs-safe-json-");
    const missing = path.join(root, "missing.json");
    const invalid = path.join(root, "invalid.json");
    await fs.writeFile(invalid, "{", "utf8");

    await expect(tryReadJson(missing)).resolves.toBeNull();
    await expect(tryReadJson(invalid)).resolves.toBeNull();
    await expect(readJsonIfExists(missing)).resolves.toBeNull();
    await expect(readJsonIfExists(invalid)).rejects.toMatchObject({
      name: "JsonFileReadError",
      reason: "parse",
    } satisfies Partial<JsonFileReadError>);
    expect(() => readJsonSync(invalid)).toThrow(JsonFileReadError);
  });

  it("does not retry initially missing nullable JSON reads", async () => {
    const root = await tempRoot("fs-safe-json-missing-");
    const missing = path.join(root, "missing.json");
    const lstatSpy = vi.spyOn(fs, "lstat");

    try {
      await expect(readJsonIfExists(missing)).resolves.toBeNull();
      await expect(tryReadJson(missing)).resolves.toBeNull();
      expect(lstatSpy.mock.calls.filter(([candidate]) => candidate === missing)).toHaveLength(2);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("does not follow symlink swaps while reading", async () => {
    const root = await tempRoot("fs-safe-json-swap-");
    const filePath = path.join(root, "state.json");
    const secretPath = path.join(root, "secret.json");
    await fs.writeFile(filePath, "{\"ok\":true}", "utf8");
    await fs.writeFile(secretPath, "{\"secret\":true}", "utf8");

    const originalLstat = fs.lstat.bind(fs);
    let swapped = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (!swapped && args[0] === filePath) {
        swapped = true;
        await fs.rm(filePath, { force: true });
        await fs.symlink(secretPath, filePath);
      }
      return stat;
    });

    try {
      await expect(readJson(filePath)).rejects.toMatchObject({
        name: "JsonFileReadError",
        reason: "read",
      } satisfies Partial<JsonFileReadError>);
      await expect(tryReadJson(filePath)).resolves.toBeNull();
    } finally {
      lstatSpy.mockRestore();
    }
  });

  itPosix("replaces symlink leaves on sync writes", async () => {
    const root = await tempRoot("fs-safe-json-link-");
    const outsidePath = path.join(root, "outside.json");
    const linkPath = path.join(root, "state.json");
    await fs.writeFile(outsidePath, "{\"secret\":true}\n", "utf8");
    await fs.symlink(outsidePath, linkPath);

    writeJsonSync(linkPath, { ok: true });

    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("{\"secret\":true}\n");
    await expect(fs.readFile(linkPath, "utf8")).resolves.toBe("{\n  \"ok\": true\n}\n");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(false);
  });

  itPosix("keeps mode 0600 on the EPERM remove-and-retry fallback", async () => {
    const root = await tempRoot("fs-safe-json-fallback-mode-");
    const filePath = path.join(root, "state.json");
    await fs.writeFile(filePath, "{\"old\":true}\n", { mode: 0o644 });
    await fs.chmod(filePath, 0o644);
    const renameSync = fsSync.renameSync.bind(fsSync);
    let renames = 0;
    const rename = vi.spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
      renames += 1;
      if (renames === 1) {
        throw Object.assign(new Error("rename denied"), { code: "EPERM" });
      }
      renameSync(source, destination);
    });
    try {
      writeJsonSync(filePath, { ok: true });
    } finally {
      rename.mockRestore();
    }

    expect(renames).toBe(2);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ ok: true });
  });

  it.each([12, 240])("writes filesystem-admitted %i-byte JSON basenames synchronously", async (length) => {
    const directory = await tempRoot("fs-safe-json-name-");
    const basename = `${"a".repeat(length - 5)}.json`;
    const filePath = path.join(directory, basename);
    await fs.writeFile(filePath, "original");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("original");

    writeJsonSync(filePath, { replacement: true });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe('{\n  "replacement": true\n}\n');
    await expect(fs.readdir(directory)).resolves.toEqual([basename]);
  });

  it("serializes work through createAsyncLock", async () => {
    const lock = createAsyncLock();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = lock(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
      return 1;
    });
    const second = lock(async () => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("reads JSON objects through a root-bounded open", async () => {
    const root = await tempRoot("fs-safe-root-json-");
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ name: "demo" }), "utf8");

    const result = readRootJsonObjectSync({
      rootDir: root,
      relativePath: "config.json",
      boundaryLabel: "test root",
      rejectHardlinks: true,
    });

    expect(result).toMatchObject({ ok: true, value: { name: "demo" } });
  });

  it("rejects invalid root-bounded JSON shapes and escapes", async () => {
    const root = await tempRoot("fs-safe-root-json-");
    const outside = path.join(path.dirname(root), `${path.basename(root)}.json`);
    await fs.writeFile(path.join(root, "array.json"), "[]", "utf8");
    await fs.writeFile(outside, JSON.stringify({ name: "outside" }), "utf8");
    try {
      expect(
        readRootJsonObjectSync({
          rootDir: root,
          relativePath: "array.json",
          boundaryLabel: "test root",
        }),
      ).toMatchObject({ ok: false, reason: "invalid" });
      expect(
        readRootJsonObjectSync({
          rootDir: root,
          relativePath: "../outside-root-json-test.json",
          boundaryLabel: "test root",
        }),
      ).toMatchObject({ ok: false, reason: "open" });
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("lets callers provide parser and validation for root-bounded structured files", async () => {
    const root = await tempRoot("fs-safe-root-structured-");
    await fs.writeFile(path.join(root, "config.txt"), "name=demo", "utf8");

    const result = readRootStructuredFileSync<{ name: string }>({
      rootDir: root,
      relativePath: "config.txt",
      boundaryLabel: "test root",
      parse: (raw) => ({ name: raw.split("=")[1]?.trim() }),
      validate: (value): value is { name: string } =>
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        typeof value.name === "string",
    });

    expect(result).toMatchObject({ ok: true, value: { name: "demo" } });
  });

  it("recovers readJson from a concurrent real atomic rewrite", async () => {
    const root = await tempRoot("fs-safe-json-retry-real-");
    const filePath = path.join(root, "paired.json");
    await writeTextAtomic(filePath, "{\"v\":0}");
    const originalOpen = fs.open.bind(fs);
    let rewriteInjected = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!rewriteInjected && args[0] === filePath) {
        rewriteInjected = true;
        // Replace the path after readRegularFile's pre-open lstat. The first
        // open observes a different inode, and readJson must recover on retry.
        await writeTextAtomic(filePath, "{\"v\":1}");
      }
      return await originalOpen(...args);
    });
    try {
      await expect(readJson<{ v: number }>(filePath)).resolves.toEqual({ v: 1 });
      expect(rewriteInjected).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("surfaces JsonFileReadError when read races exceed retry budget", async () => {
    const root = await tempRoot("fs-safe-json-retry-exhaust-");
    const filePath = path.join(root, "paired.json");
    await writeTextAtomic(filePath, "{\"v\":0}");

    let racesInjected = 0;
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === filePath) {
        racesInjected += 1;
        throw new FsSafeError("path-mismatch", "injected read race");
      }
      return await originalOpen(...args);
    });

    try {
      await expect(readJson(filePath)).rejects.toMatchObject({
        name: "JsonFileReadError",
        reason: "read",
        cause: expect.objectContaining({ code: "path-mismatch" }),
      } satisfies Partial<JsonFileReadError>);
      expect(racesInjected).toBe(5);
    } finally {
      openSpy.mockRestore();
    }
  });
});
