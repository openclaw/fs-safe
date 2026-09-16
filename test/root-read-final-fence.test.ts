import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { root, type Root, type SymlinkPolicy } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
});

const operations = ["open", "readText", "readAbsolute"] as const;
type Operation = typeof operations[number];

async function replacementFixture(prefix: string, relativePath = "value") {
  const base = await tempRoot(prefix);
  const active = path.join(base, "root");
  const displaced = path.join(base, "displaced");
  const successor = path.join(base, "successor");
  await fs.mkdir(path.dirname(path.join(active, relativePath)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(successor, relativePath)), { recursive: true });
  await fs.writeFile(path.join(active, relativePath), "original");
  await fs.writeFile(path.join(successor, relativePath), "replacement");
  const scoped = await root(active);
  let state: "original" | "replacement" = "original";
  return {
    active,
    displaced,
    filePath: path.join(active, relativePath),
    relativePath,
    scoped,
    successor,
    get state() {
      return state;
    },
    replace() {
      if (state === "replacement") return;
      fsSync.renameSync(active, displaced);
      fsSync.renameSync(successor, active);
      state = "replacement";
    },
    restore() {
      if (state === "original") return;
      fsSync.renameSync(active, successor);
      fsSync.renameSync(displaced, active);
      state = "original";
    },
  };
}

function observeOpenedHandle(filePath: string) {
  let handle: FileHandle | undefined;
  let close: ReturnType<typeof vi.spyOn> | undefined;
  let read: ReturnType<typeof vi.spyOn> | undefined;
  let readFile: ReturnType<typeof vi.spyOn> | undefined;
  return {
    hook(candidate: string, opened: FileHandle) {
      if (candidate !== filePath) return;
      handle = opened;
      close = vi.spyOn(opened, "close");
      read = vi.spyOn(opened, "read");
      readFile = vi.spyOn(opened, "readFile");
    },
    get handle() {
      return handle;
    },
    get close() {
      return close;
    },
    get read() {
      return read;
    },
    get readFile() {
      return readFile;
    },
  };
}

async function invoke(
  fixture: Awaited<ReturnType<typeof replacementFixture>>,
  operation: Operation,
) {
  if (operation === "open") return await fixture.scoped.open(fixture.relativePath);
  if (operation === "readText") return await fixture.scoped.readText(fixture.relativePath);
  return (await fixture.scoped.readAbsolute(fixture.filePath)).buffer.toString();
}

const aliasOperations = [...operations, "reader"] as const;
type AliasOperation = typeof aliasOperations[number];

function invokeAlias(
  scoped: Root,
  operation: AliasOperation,
  relativePath: string,
  absolutePath: string,
  symlinks: SymlinkPolicy,
) {
  if (operation === "open") return scoped.open(relativePath, { symlinks });
  if (operation === "readText") return scoped.readText(relativePath, { symlinks });
  if (operation === "readAbsolute") return scoped.readAbsolute(absolutePath, { symlinks });
  return scoped.reader({ symlinks })(absolutePath);
}

itPosix.each(operations)(
  "%s rejects a persistent replacement root before reading or handing off the handle",
  async (operation) => {
    const fixture = await replacementFixture(`fs-safe-root-read-persistent-${operation}-`);
    const observed = observeOpenedHandle(fixture.filePath);
    const afterFile = vi.fn();
    __setFsSafeTestHooksForTest({
      afterRootReadPathResolution(candidate) {
        if (candidate === fixture.filePath) fixture.replace();
      },
      afterOpen: observed.hook,
      afterRootReadFinalPathIdentityCheck: afterFile,
    });

    await expect(invoke(fixture, operation)).rejects.toMatchObject({ code: "path-mismatch" });

    expect(fixture.state).toBe("replacement");
    expect(observed.handle?.fd).toBe(-1);
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
    expect(afterFile).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(fixture.displaced, "value"), "utf8")).resolves.toBe("original");
    await expect(fs.readFile(fixture.filePath, "utf8")).resolves.toBe("replacement");
  },
);

itPosix.each(operations)(
  "%s rejects replacement bytes after the original root is restored before the final fence",
  async (operation) => {
    const fixture = await replacementFixture(`fs-safe-root-read-aba-${operation}-`);
    const observed = observeOpenedHandle(fixture.filePath);
    __setFsSafeTestHooksForTest({
      afterRootReadPathResolution(candidate) {
        if (candidate === fixture.filePath) fixture.replace();
      },
      afterOpen: observed.hook,
      beforeRootReadFinalFence(candidate) {
        if (candidate === fixture.filePath) fixture.restore();
      },
    });

    await expect(invoke(fixture, operation)).rejects.toMatchObject({ code: "path-mismatch" });

    expect(fixture.state).toBe("original");
    expect(observed.handle?.fd).toBe(-1);
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
    await expect(fs.readFile(fixture.filePath, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(path.join(fixture.successor, "value"), "utf8")).resolves.toBe("replacement");
  },
);

itPosix.each(aliasOperations)(
  "%s rejects a followed leaf alias to the matching opened file outside the restored root",
  async (operation) => {
    const fixture = await replacementFixture(`fs-safe-root-read-leaf-alias-${operation}-`);
    const observed = observeOpenedHandle(fixture.filePath);
    const originalPath = path.join(fixture.active, "original-value");
    __setFsSafeTestHooksForTest({
      afterRootReadPathResolution(candidate) {
        if (candidate === fixture.filePath) fixture.replace();
      },
      afterOpen: observed.hook,
      beforeRootReadFinalFence(candidate, handle) {
        if (candidate !== fixture.filePath) return;
        fixture.restore();
        fsSync.renameSync(fixture.filePath, originalPath);
        fsSync.symlinkSync(path.join(fixture.successor, "value"), fixture.filePath, "file");
        const pathStat = fsSync.statSync(candidate, { bigint: true });
        const handleStat = fsSync.fstatSync(handle.fd, { bigint: true });
        expect({ dev: pathStat.dev, ino: pathStat.ino })
          .toEqual({ dev: handleStat.dev, ino: handleStat.ino });
      },
    });

    await expect(invokeAlias(
      fixture.scoped, operation, fixture.relativePath, fixture.filePath, "follow-within-root",
    )).rejects.toMatchObject({ code: "outside-workspace" });

    expect(observed.handle?.fd).toBe(-1);
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
    expect((await fs.lstat(fixture.filePath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(originalPath, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(path.join(fixture.successor, "value"), "utf8")).resolves.toBe("replacement");
  },
);

itPosix.each(aliasOperations)(
  "%s rejects a parent alias to the matching opened file outside the restored root",
  async (operation) => {
    const fixture = await replacementFixture(
      `fs-safe-root-read-parent-alias-${operation}-`,
      path.join("parent", "value"),
    );
    const observed = observeOpenedHandle(fixture.filePath);
    const parentPath = path.dirname(fixture.filePath);
    const originalParent = path.join(fixture.active, "original-parent");
    __setFsSafeTestHooksForTest({
      afterRootReadPathResolution(candidate) {
        if (candidate === fixture.filePath) fixture.replace();
      },
      afterOpen: observed.hook,
      beforeRootReadFinalFence(candidate, handle) {
        if (candidate !== fixture.filePath) return;
        fixture.restore();
        fsSync.renameSync(parentPath, originalParent);
        fsSync.symlinkSync(path.join(fixture.successor, "parent"), parentPath, "dir");
        const pathStat = fsSync.lstatSync(candidate, { bigint: true });
        const handleStat = fsSync.fstatSync(handle.fd, { bigint: true });
        expect({ dev: pathStat.dev, ino: pathStat.ino })
          .toEqual({ dev: handleStat.dev, ino: handleStat.ino });
      },
    });

    await expect(invokeAlias(
      fixture.scoped, operation, fixture.relativePath, fixture.filePath, "reject",
    )).rejects.toMatchObject({ code: "outside-workspace" });

    expect(observed.handle?.fd).toBe(-1);
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
    expect((await fs.lstat(parentPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(path.join(originalParent, "value"), "utf8")).resolves.toBe("original");
    await expect(fs.readFile(path.join(fixture.successor, "parent", "value"), "utf8"))
      .resolves.toBe("replacement");
  },
);

itPosix.each([
  ...aliasOperations.map(operation => ({ kind: "leaf" as const, operation })),
  ...aliasOperations.map(operation => ({ kind: "parent" as const, operation })),
])("$operation preserves a contained $kind alias", async ({ kind, operation }) => {
  const directory = await tempRoot(`fs-safe-root-read-contained-${kind}-${operation}-`);
  const target = path.join(directory, "actual", "value");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "original");
  const aliasPath = path.join(directory, "alias");
  if (kind === "leaf") fsSync.symlinkSync(target, aliasPath, "file");
  else fsSync.symlinkSync(path.dirname(target), aliasPath, "dir");
  const relativePath = kind === "leaf" ? "alias" : path.join("alias", "value");
  const absolutePath = path.join(directory, relativePath);
  const symlinks = kind === "leaf" ? "follow-within-root" : "follow-parents-within-root";
  const scoped = await root(directory);

  if (operation === "open") {
    const result = await scoped.open(relativePath, { symlinks });
    expect(result.realPath).toBe(target);
    try {
      await expect(result.handle.readFile("utf8")).resolves.toBe("original");
    } finally {
      await result.handle.close();
    }
  } else if (operation === "readText") {
    await expect(scoped.readText(relativePath, { symlinks })).resolves.toBe("original");
  } else if (operation === "readAbsolute") {
    const result = await scoped.readAbsolute(absolutePath, { symlinks });
    expect(result.realPath).toBe(target);
    expect(result.buffer.toString()).toBe("original");
  } else {
    await expect(scoped.reader({ symlinks })(absolutePath)).resolves.toEqual(Buffer.from("original"));
  }
});

itPosix("closes without reading when the fresh canonical target disappears", async () => {
  const fixture = await replacementFixture("fs-safe-root-read-final-missing-");
  const observed = observeOpenedHandle(fixture.filePath);
  const realpath = realpathSync.native;
  let finalFence = false;
  vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
    if (finalFence && String(args[0]) === fixture.filePath) {
      throw Object.assign(new Error("final canonical target disappeared"), { code: "ENOENT" });
    }
    return realpath(...args);
  });
  __setFsSafeTestHooksForTest({
    afterOpen: observed.hook,
    beforeRootReadFinalFence() {
      finalFence = true;
    },
  });

  await expect(fixture.scoped.readText(fixture.relativePath)).rejects.toMatchObject({ code: "not-found" });
  expect(observed.handle?.fd).toBe(-1);
  expect(observed.close).toHaveBeenCalledTimes(1);
  expect(observed.read).not.toHaveBeenCalled();
  expect(observed.readFile).not.toHaveBeenCalled();
});

itPosix("preserves a fresh canonical failure when descriptor close also fails", async () => {
  const fixture = await replacementFixture("fs-safe-root-read-final-close-failure-");
  const observed = observeOpenedHandle(fixture.filePath);
  const realpath = realpathSync.native;
  const closeFailure = new Error("injected close failure");
  let finalFence = false;
  let actualClose: (() => Promise<void>) | undefined;
  vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
    if (finalFence && String(args[0]) === fixture.filePath) {
      throw Object.assign(new Error("final canonical target disappeared"), { code: "ENOENT" });
    }
    return realpath(...args);
  });
  __setFsSafeTestHooksForTest({
    afterOpen(candidate, handle) {
      actualClose = handle.close.bind(handle);
      observed.hook(candidate, handle);
      observed.close!.mockRejectedValueOnce(closeFailure);
    },
    beforeRootReadFinalFence() {
      finalFence = true;
    },
  });

  try {
    await expect(fixture.scoped.readText(fixture.relativePath))
      .rejects.toMatchObject({ code: "not-found" });
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
  } finally {
    observed.close?.mockRestore();
    await actualClose?.();
  }
});

itPosix("rejects a persistently unknown Windows identity at the fresh canonical target", async () => {
  const fixture = await replacementFixture("fs-safe-root-read-final-windows-unknown-");
  const observed = observeOpenedHandle(fixture.filePath);
  const realpath = realpathSync.native;
  const lstat = fsSync.lstatSync.bind(fsSync);
  let finalFence = false;
  let canonicalIdentity = false;
  vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
    const result = realpath(...args);
    if (finalFence && String(args[0]) === fixture.filePath) canonicalIdentity = true;
    return result;
  });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (canonicalIdentity && String(args[0]) === fixture.filePath && args[1]?.bigint) {
      (stat as fsSync.BigIntStats).ino = 0n;
    }
    return stat;
  });
  __setFsSafeTestHooksForTest({
    afterOpen: observed.hook,
    beforeRootReadFinalFence() {
      finalFence = true;
    },
  });
  Object.defineProperty(process, "platform", { value: "win32" });

  await expect(fixture.scoped.readText(fixture.relativePath)).rejects.toMatchObject({ code: "path-mismatch" });
  expect(observed.handle?.fd).toBe(-1);
  expect(observed.close).toHaveBeenCalledTimes(1);
  expect(observed.read).not.toHaveBeenCalled();
  expect(observed.readFile).not.toHaveBeenCalled();
});

itPosix.each(operations)(
  "%s rejects a root replacement after the final pathname identity observation",
  async (operation) => {
    const fixture = await replacementFixture(`fs-safe-root-read-tail-${operation}-`);
    const observed = observeOpenedHandle(fixture.filePath);
    __setFsSafeTestHooksForTest({
      afterOpen: observed.hook,
      afterRootReadFinalPathIdentityCheck(candidate) {
        if (candidate === fixture.filePath) fixture.replace();
      },
    });

    await expect(invoke(fixture, operation)).rejects.toMatchObject({ code: "path-mismatch" });

    expect(fixture.state).toBe("replacement");
    expect(observed.handle?.fd).toBe(-1);
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).not.toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(fixture.displaced, "value"), "utf8")).resolves.toBe("original");
    await expect(fs.readFile(fixture.filePath, "utf8")).resolves.toBe("replacement");
  },
);

itPosix.each(operations)("%s preserves unchanged reads and descriptor handoff", async (operation) => {
  const fixture = await replacementFixture(`fs-safe-root-read-control-${operation}-`);
  const observed = observeOpenedHandle(fixture.filePath);
  const resolved = vi.fn();
  const beforeFence = vi.fn();
  const afterFile = vi.fn();
  __setFsSafeTestHooksForTest({
    afterRootReadPathResolution: resolved,
    afterOpen: observed.hook,
    beforeRootReadFinalFence: beforeFence,
    afterRootReadFinalPathIdentityCheck: afterFile,
  });

  const result = await invoke(fixture, operation);

  expect(resolved).toHaveBeenCalledExactlyOnceWith(fixture.filePath);
  expect(beforeFence).toHaveBeenCalledExactlyOnceWith(fixture.filePath, observed.handle);
  expect(afterFile).toHaveBeenCalledExactlyOnceWith(fixture.filePath, observed.handle);
  expect(fixture.state).toBe("original");
  if (typeof result === "string") {
    expect(result).toBe("original");
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.read).toHaveBeenCalled();
    expect(observed.readFile).not.toHaveBeenCalled();
    return;
  }

  expect(result.handle).toBe(observed.handle);
  expect(result.handle.fd).not.toBe(-1);
  expect(observed.close).not.toHaveBeenCalled();
  expect(await result.handle.readFile("utf8")).toBe("original");
  await result.handle.close();
  expect(observed.close).toHaveBeenCalledTimes(1);
});
