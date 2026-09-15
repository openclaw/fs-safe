import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  __setFsSafeTestHooksForTest();
});

async function replaceDirectoryWithAlias(directory: string, replacement: string): Promise<void> {
  await fs.rename(directory, `${directory}-original`);
  await fs.symlink(replacement, directory, process.platform === "win32" ? "junction" : "dir");
}

it("rejects stat metadata when a selected parent is redirected before observation", async () => {
  const container = await tempRoot("fs-safe-stat-parent-containment-");
  const rootDir = path.join(container, "root");
  const selected = path.join(rootDir, "selected");
  const outside = path.join(container, "outside");
  await fs.mkdir(selected, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(selected, "value"), "inside");
  await fs.writeFile(path.join(outside, "value"), "outside metadata must not be returned");
  const capability = await root(rootDir);
  let intercepted = false;
  __setFsSafeTestHooksForTest({
    async beforeRootStatObservation(targetPath) {
      expect(targetPath).toBe(path.join(selected, "value"));
      intercepted = true;
      await replaceDirectoryWithAlias(selected, outside);
    },
  });

  await expect(capability.stat("selected/value")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(intercepted).toBe(true);
  await expect(fs.readFile(path.join(outside, "value"), "utf8"))
    .resolves.toBe("outside metadata must not be returned");
});

it("rejects stat metadata when the exact selected target becomes an outside alias", async () => {
  const container = await tempRoot("fs-safe-stat-target-containment-");
  const rootDir = path.join(container, "root");
  const selected = path.join(rootDir, "selected");
  const target = path.join(selected, "target");
  const outside = path.join(container, "outside");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret"), "outside");
  const capability = await root(rootDir);
  __setFsSafeTestHooksForTest({
    async beforeRootStatObservation(targetPath) {
      expect(targetPath).toBe(target);
      await replaceDirectoryWithAlias(target, outside);
    },
  });

  await expect(capability.stat("selected/target")).rejects.toMatchObject({ code: "path-mismatch" });
});

it("checks the admitted parent before exposing an initial not-found observation", async () => {
  const container = await tempRoot("fs-safe-stat-initial-error-containment-");
  const rootDir = path.join(container, "root");
  const selected = path.join(rootDir, "selected");
  const original = `${selected}-original`;
  const outside = path.join(container, "outside");
  await fs.mkdir(selected, { recursive: true });
  await fs.mkdir(outside);
  const capability = await root(rootDir);
  __setFsSafeTestHooksForTest({
    async beforeRootStatInitialObservation(targetPath) {
      expect(targetPath).toBe(path.join(selected, "missing"));
      await replaceDirectoryWithAlias(selected, outside);
    },
  });

  try {
    await expect(capability.stat("selected/missing")).rejects.toMatchObject({ code: "path-mismatch" });
  } finally {
    __setFsSafeTestHooksForTest();
    await fs.unlink(selected);
    await fs.rename(original, selected);
  }
  await expect(capability.stat("selected/missing")).rejects.toMatchObject({ code: "not-found" });
  await expect(capability.exists("selected/missing")).resolves.toBe(false);
});

it.each([false, true])(
  "preserves not-found when list selects an existing regular file (withFileTypes=%s)",
  async (withFileTypes) => {
    const rootDir = await tempRoot("fs-safe-list-file-compatibility-");
    await fs.writeFile(path.join(rootDir, "value"), "not a directory");
    const capability = await root(rootDir);

    const listing = withFileTypes
      ? capability.list("value", { withFileTypes: true })
      : capability.list("value");
    await expect(listing).rejects.toMatchObject({ code: "not-found" });
  },
);

it.skipIf(process.platform === "win32")(
  "reuses exact traversal receipts without redundant metadata or canonicalization calls",
  async () => {
    const rootDir = await tempRoot("fs-safe-stat-list-fused-receipt-");
    const selected = path.join(rootDir, "selected");
    await fs.mkdir(selected);
    const direct = path.join(rootDir, "direct");
    const nested = path.join(selected, "value");
    await fs.writeFile(direct, "inside");
    await fs.writeFile(nested, "inside");
    const originalStat = fsSync.statSync.bind(fsSync);
    const originalLstat = fsSync.lstatSync.bind(fsSync);
    const project = (stat: fsSync.Stats | fsSync.BigIntStats) => Object.assign(Object.create(stat),
      typeof stat.dev === "bigint" ? { dev: 7n, ino: 11n } : { dev: 7, ino: 11 });
    const stat = vi.spyOn(fsSync, "statSync").mockImplementation((candidate, options) =>
      project(originalStat(candidate, options as never)));
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) =>
      project(originalLstat(candidate, options as never)));
    const capability = await root(rootDir);
    const realpath = vi.spyOn(realpathSync, "native");
    try {
      await expect(capability.stat("direct")).resolves.toMatchObject({ isFile: true });
      expect(lstat).toHaveBeenCalledTimes(4);
      expect(realpath).toHaveBeenCalledTimes(1);

      lstat.mockClear();
      realpath.mockClear();
      await expect(capability.stat("selected/value")).resolves.toMatchObject({ isFile: true });
      expect(lstat).toHaveBeenCalledTimes(6);
      expect(realpath).toHaveBeenCalledTimes(2);

      lstat.mockClear();
      realpath.mockClear();
      await expect(capability.list("selected", { withFileTypes: true })).resolves.toEqual([
        expect.objectContaining({ name: "value", isFile: true }),
      ]);
      expect(lstat).toHaveBeenCalledTimes(5);
      expect(realpath).toHaveBeenCalledTimes(2);
    } finally {
      stat.mockRestore();
      lstat.mockRestore();
      realpath.mockRestore();
    }
  },
);

it.each(["ENOENT", "ENOTDIR"])(
  "normalizes %s from traversal receipt canonicalization",
  async (code) => {
    const rootDir = await tempRoot("fs-safe-observation-canonical-error-");
    const selected = path.join(rootDir, "selected");
    await fs.mkdir(selected);
    await fs.writeFile(path.join(selected, "value"), "inside");
    const capability = await root(rootDir);
    const native = realpathSync.native.bind(realpathSync);
    const failure = Object.assign(new Error("canonicalization unavailable"), { code });
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation((candidate) => {
      if (path.resolve(String(candidate)) === selected) throw failure;
      return native(candidate);
    });
    try {
      await expect(capability.stat("selected/value")).rejects.toMatchObject({ code: "not-found" });
      await expect(capability.exists("selected/value")).resolves.toBe(false);
      await expect(capability.list("selected")).rejects.toMatchObject({ code: "not-found" });
    } finally {
      realpath.mockRestore();
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "handles a persistent unknown identity as an ordinary non-directory observation",
  async () => {
    const rootDir = await tempRoot("fs-safe-list-file-zero-identity-");
    const filePath = path.join(rootDir, "value");
    await fs.writeFile(filePath, "inside");
    const capability = await root(rootDir);
    const originalLstat = fsSync.lstatSync.bind(fsSync);
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const stat = originalLstat(candidate, options as never);
      return path.resolve(String(candidate)) === filePath && typeof stat.dev === "bigint"
        ? Object.assign(Object.create(stat), { dev: 0n, ino: 0n })
        : stat;
    });
    try {
      await expect(capability.list("value")).rejects.toMatchObject({ code: "not-found" });
      await expect(capability.list("value", { withFileTypes: true }))
        .rejects.toMatchObject({ code: "not-found" });
      await expect(capability.stat("value/child")).rejects.toMatchObject({ code: "path-alias" });
    } finally {
      lstat.mockRestore();
    }
  },
);

it.each([false, true])(
  "rejects a redirected selected directory before returning list metadata (withFileTypes=%s)",
  async (withFileTypes) => {
    const container = await tempRoot("fs-safe-list-containment-");
    const rootDir = path.join(container, "root");
    const selected = path.join(rootDir, "selected");
    const outside = path.join(container, "outside");
    await fs.mkdir(selected, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(selected, "inside"), "inside");
    await fs.writeFile(path.join(outside, "outside-secret"), "outside metadata must not be returned");
    const capability = await root(rootDir);
    let interceptedMode: boolean | undefined;
    __setFsSafeTestHooksForTest({
      async beforeRootListObservation(directoryPath, observedWithFileTypes) {
        expect(directoryPath).toBe(selected);
        interceptedMode = observedWithFileTypes;
        await replaceDirectoryWithAlias(selected, outside);
      },
    });

    const listing = withFileTypes
      ? capability.list("selected", { withFileTypes: true })
      : capability.list("selected");
    await expect(listing).rejects.toMatchObject({ code: "path-mismatch" });
    expect(interceptedMode).toBe(withFileTypes);
    await expect(fs.readdir(outside)).resolves.toEqual(["outside-secret"]);
  },
);
