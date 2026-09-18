import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fileStore } from "../src/file-store.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const now = 2_000_000_000_000;
const ttlMs = 30_000;
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
});

it("does not read the private removal marker from public options", async () => {
  const directory = await tempRoot("fs-safe-remove-proxy-options-");
  const target = path.join(directory, "file.txt");
  await fs.writeFile(target, "owned");
  const scopedRoot = await root(directory);
  const symbols: symbol[] = [];
  const options = new Proxy({}, {
    get(target, property, receiver) {
      if (typeof property === "symbol") {
        symbols.push(property);
        throw new Error("unexpected private option read");
      }
      return Reflect.get(target, property, receiver);
    },
  });

  await scopedRoot.remove("file.txt", options);

  expect(symbols).toEqual([]);
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

async function fixture(privateMode = false) {
  const rootDir = await tempRoot("fs-safe-prune-expiry-");
  const store = fileStore({ rootDir, private: privateMode });
  const target = path.join(rootDir, "entry.txt");
  await fs.writeFile(target, "expired");
  await fs.utimes(target, new Date(now - 60_000), new Date(now - 60_000));
  vi.spyOn(Date, "now").mockReturnValue(now);
  return { rootDir, store, target };
}

it.each([false, true].flatMap(privateMode => ["replacement", "in-place update"].map(change => ({ privateMode, change }))))(
  "keeps files refreshed by $change while preparing removal (private=$privateMode)", async ({ privateMode, change }) => {
    const { rootDir, store, target } = await fixture(privateMode);
    const sibling = path.join(rootDir, "sibling.txt");
    await fs.writeFile(sibling, "expired sibling");
    await fs.utimes(sibling, new Date(0), new Date(0));
    const original = await fs.stat(target, { bigint: true });
    let changed = false;
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, targetPath) {
        if (operation !== "remove" || targetPath !== target || changed) return;
        if (change === "replacement") {
          const replacement = path.join(rootDir, "replacement.txt");
          await fs.writeFile(replacement, "fresh");
          await fs.utimes(replacement, new Date(now), new Date(now));
          await fs.rename(replacement, target);
        } else {
          await fs.writeFile(target, "fresh");
          await fs.utimes(target, new Date(now), new Date(now));
        }
        changed = true;
      },
    });

    await store.pruneExpired({ ttlMs });

    expect(changed).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("fresh");
    if (change === "in-place update") {
      expect((await fs.stat(target, { bigint: true })).ino).toBe(original.ino);
    }
    await expect(fs.lstat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("still prunes a replacement whose own timestamp is expired", async () => {
  const { rootDir, store, target } = await fixture();
  let changed = false;
  __setFsSafeTestHooksForTest({
    async beforeRootFallbackMutation(operation, targetPath) {
      if (operation !== "remove" || targetPath !== target || changed) return;
      const replacement = path.join(rootDir, "replacement.txt");
      await fs.writeFile(replacement, "also expired");
      await fs.utimes(replacement, new Date(now - 60_000), new Date(now - 60_000));
      await fs.rename(replacement, target);
      changed = true;
    },
  });

  await store.pruneExpired({ ttlMs });

  expect(changed).toBe(true);
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a directory substituted for an expired file", async () => {
  const { store, target } = await fixture();
  let changed = false;
  __setFsSafeTestHooksForTest({
    async beforeRootFallbackMutation(operation, targetPath) {
      if (operation !== "remove" || targetPath !== target || changed) return;
      await fs.unlink(target);
      await fs.mkdir(target);
      await fs.utimes(target, new Date(0), new Date(0));
      changed = true;
    },
  });

  await store.pruneExpired({ ttlMs });

  expect(changed).toBe(true);
  expect((await fs.lstat(target)).isDirectory()).toBe(true);
});

itPosix("keeps a symlink substituted for an expired file", async () => {
  const { rootDir, store, target } = await fixture();
  const fresh = path.join(rootDir, "fresh.txt");
  await fs.writeFile(fresh, "fresh");
  await fs.utimes(fresh, new Date(now), new Date(now));
  let changed = false;
  __setFsSafeTestHooksForTest({
    async beforeRootFallbackMutation(operation, targetPath) {
      if (operation !== "remove" || targetPath !== target || changed) return;
      await fs.unlink(target);
      await fs.symlink(fresh, target);
      changed = true;
    },
  });

  await store.pruneExpired({ ttlMs });

  expect(changed).toBe(true);
  expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(fresh, "utf8")).toBe("fresh");
});

itPosix("prunes expired files without requiring permission to read them", async () => {
  const { store, target } = await fixture();
  await fs.chmod(target, 0);
  try {
    if (process.getuid?.() !== 0) {
      await expect(fs.readFile(target)).rejects.toMatchObject({ code: "EACCES" });
    }
    await store.pruneExpired({ ttlMs });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.chmod(target, 0o600).catch(() => undefined);
  }
});

it("keeps fractional-millisecond expiry comparisons at the removal boundary", async () => {
  const { store, target } = await fixture();
  const lstat = fsSync.lstatSync.bind(fsSync);
  let refreshed = false;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (String(args[0]) === target && refreshed && typeof stat.mtimeMs === "number") {
      stat.mtimeMs = now - ttlMs + 0.25;
    }
    return stat;
  });
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation(operation, targetPath) {
      if (operation === "remove" && targetPath === target) refreshed = true;
    },
  });

  await store.pruneExpired({ ttlMs: ttlMs - 0.125 });

  expect(refreshed).toBe(true);
  expect(await fs.readFile(target, "utf8")).toBe("expired");
});

it.each([false, true])(
  "keeps a fresh file substituted for an observed empty directory (private=%s)",
  async privateMode => {
    const rootDir = await tempRoot("fs-safe-prune-empty-dir-");
    const store = fileStore({ rootDir, private: privateMode });
    const target = path.join(rootDir, "empty");
    const sibling = path.join(rootDir, "expired.txt");
    await fs.mkdir(target);
    await fs.writeFile(sibling, "expired");
    await fs.utimes(sibling, new Date(0), new Date(0));
    vi.spyOn(Date, "now").mockReturnValue(now);
    let replaced = false;
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, targetPath) {
        if (operation !== "remove" || targetPath !== target || replaced) return;
        await fs.rmdir(target);
        await fs.writeFile(target, "fresh replacement");
        replaced = true;
      },
    });

    await store.pruneExpired({ ttlMs, recursive: true, pruneEmptyDirs: true });

    expect(replaced).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("fresh replacement");
    await expect(fs.lstat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([false, true])(
  "keeps a directory that becomes nonempty before empty-directory removal (private=%s)",
  async privateMode => {
    const rootDir = await tempRoot("fs-safe-prune-nonempty-dir-");
    const store = fileStore({ rootDir, private: privateMode });
    const target = path.join(rootDir, "empty");
    const child = path.join(target, "fresh.txt");
    await fs.mkdir(target);
    let populated = false;
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, targetPath) {
        if (operation !== "remove" || targetPath !== target || populated) return;
        await fs.writeFile(child, "fresh");
        populated = true;
      },
    });

    await store.pruneExpired({ ttlMs, recursive: true, pruneEmptyDirs: true });

    expect(populated).toBe(true);
    expect(await fs.readFile(child, "utf8")).toBe("fresh");
  },
);

itPosix.each([false, true])(
  "keeps a symlink substituted for an observed empty directory (private=%s)",
  async privateMode => {
    const rootDir = await tempRoot("fs-safe-prune-empty-dir-link-");
    const store = fileStore({ rootDir, private: privateMode });
    const target = path.join(rootDir, "empty");
    const referent = path.join(rootDir, "referent");
    const child = path.join(referent, "fresh.txt");
    await fs.mkdir(target);
    await fs.mkdir(referent);
    await fs.writeFile(child, "fresh");
    let replaced = false;
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, targetPath) {
        if (operation !== "remove" || targetPath !== target || replaced) return;
        await fs.rmdir(target);
        await fs.symlink(referent, target);
        replaced = true;
      },
    });

    await store.pruneExpired({ ttlMs, recursive: true, pruneEmptyDirs: true });

    expect(replaced).toBe(true);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(child, "utf8")).toBe("fresh");
  },
);
