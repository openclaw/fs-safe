import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { FsSafeError, type FsSafeErrorCode } from "../src/errors.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import {
  tempWorkspace,
  tempWorkspaceSync,
} from "../src/private-temp-workspace.js";
import { readSecretFileSync, tryReadSecretFileSync } from "../src/secret-file.js";
import { readSecretFile, tryReadSecretFile } from "../src/secret-read-async.js";
import { realpathSync } from "../src/realpath.js";
import {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
} from "../src/symlink-parents.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

function captureThrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw");
}

async function captureRejected(operation: PromiseLike<unknown>): Promise<unknown> {
  return await operation.then(
    () => {
      throw new Error("Expected operation to reject");
    },
    (error: unknown) => error,
  );
}

function expectFsSafeCode(error: unknown, code: FsSafeErrorCode): void {
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code });
}

describe("sync and async public contracts", () => {
  it.each([
    { stage: "open", errno: "EACCES", syncCode: "path-mismatch", asyncCode: "read-failed" },
    { stage: "open", errno: "ENOENT", syncCode: "not-found", asyncCode: "not-found" },
    { stage: "open", errno: "ELOOP", syncCode: "not-found", asyncCode: "read-failed" },
    { stage: "read", errno: "EIO", syncCode: "read-failed", asyncCode: "read-failed" },
    { stage: "read", errno: "ENOENT", syncCode: "read-failed", asyncCode: "not-found" },
    { stage: "read", errno: "ENOTDIR", syncCode: "read-failed", asyncCode: "not-found" },
  ] as const)("preserves secret $stage failure semantics for $errno", async ({ stage, errno, syncCode, asyncCode }) => {
    const root = await tempRoot("fs-safe-secret-read-io-");
    const filePath = path.join(root, "token");
    await fs.writeFile(filePath, "secret");
    const failure = Object.assign(new Error(`${stage} failed`), { code: errno });

    vi.spyOn(fsSync, stage === "open" ? "openSync" : "readSync").mockImplementation(() => {
      throw failure;
    });
    const syncError = captureThrown(() => readSecretFileSync(filePath, "token"));

    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (stage === "open") throw failure;
      const handle = await realOpen(...args);
      vi.spyOn(handle, "read").mockRejectedValueOnce(failure);
      return handle;
    });
    const asyncError = await captureRejected(readSecretFile(filePath, "token"));

    for (const [error, code] of [[syncError, syncCode], [asyncError, asyncCode]] as const) {
      expectFsSafeCode(error, code);
      expect(error).toMatchObject({
        category: code === "path-mismatch" ? "policy" : "operational",
        cause: failure,
        message: `Failed to read token file at ${filePath}: Error: ${stage} failed`,
      });
    }
    if (syncCode === "not-found") {
      expect(tryReadSecretFileSync(filePath, "token")).toBeUndefined();
    } else {
      expect(() => tryReadSecretFileSync(filePath, "token")).toThrow(syncError as Error);
    }
    if (asyncCode === "not-found") {
      await expect(tryReadSecretFile(filePath, "token")).resolves.toBeUndefined();
    } else {
      await expect(tryReadSecretFile(filePath, "token")).rejects.toThrow(asyncError as Error);
    }
  });

  it.each(["", " \n", "oversized"])("preserves unwrapped secret validation errors for %j", async (content) => {
    const root = await tempRoot("fs-safe-secret-validation-");
    const filePath = path.join(root, "token");
    await fs.writeFile(filePath, content);
    const options = { maxBytes: 4 };
    const expected = {
      code: content === "oversized" ? "too-large" : "invalid-path",
      message: `token file at ${filePath} ${content === "oversized" ? "exceeds 4 bytes" : "is empty"}.`,
      cause: undefined,
    };
    expect(captureThrown(() => readSecretFileSync(filePath, "token", options))).toMatchObject(expected);
    expect(captureThrown(() => tryReadSecretFileSync(filePath, "token", options))).toMatchObject(expected);
    expect(await captureRejected(readSecretFile(filePath, "token", options))).toMatchObject(expected);
    expect(await captureRejected(tryReadSecretFile(filePath, "token", options))).toMatchObject(expected);
  });

  it("rejects unsafe device paths with the same device-path code on sync and async", async () => {
    const devicePath = process.platform === "win32" ? path.resolve("CON") : "/dev/urandom";
    const inspectBlocked = new Error("inspect should not run for reserved device paths");
    const openBlocked = new Error("open should not run for reserved device paths");
    vi.spyOn(fsSync, "statSync").mockImplementation(() => {
      throw inspectBlocked;
    });
    vi.spyOn(fsSync, "lstatSync").mockImplementation(() => {
      throw inspectBlocked;
    });
    vi.spyOn(fsSync, "openSync").mockImplementation(() => {
      throw openBlocked;
    });
    vi.spyOn(fs, "stat").mockRejectedValue(inspectBlocked);
    vi.spyOn(fs, "lstat").mockRejectedValue(inspectBlocked);
    vi.spyOn(realpathSync, "native").mockImplementation(() => { throw openBlocked; });
    vi.spyOn(fs, "open").mockRejectedValue(openBlocked);

    const syncError = captureThrown(() => readSecretFileSync(devicePath, "token"));
    const asyncError = await captureRejected(readSecretFile(devicePath, "token"));
    for (const error of [syncError, asyncError]) {
      expectFsSafeCode(error, "device-path");
      expect(error).toMatchObject({
        message: `Failed to inspect token file at ${devicePath}: FsSafeError: file reads from unsafe device paths are not allowed: ${devicePath}`,
      });
    }
  });

  it("does not reclassify path resolution failures as optional missing secrets", async () => {
    const failure = Object.assign(new Error("cwd unavailable"), { code: "ENOENT" });
    const resolve = path.resolve.bind(path);
    const resolvePath = vi.spyOn(path, "resolve").mockImplementation((...segments) => {
      if (segments.length === 1 && segments[0] === "token") throw failure;
      return resolve(...segments);
    });
    try {
      expect(captureThrown(() => readSecretFileSync("token", "token"))).toBe(failure);
      expect(captureThrown(() => tryReadSecretFileSync("token", "token"))).toBe(failure);
      expect(await captureRejected(readSecretFile("token", "token"))).toBe(failure);
      expect(await captureRejected(tryReadSecretFile("token", "token"))).toBe(failure);
    } finally {
      resolvePath.mockRestore();
    }
  });

  it("reports FileStore directory reads as not-file", async () => {
    const root = await tempRoot("fs-safe-store-directory-read-");
    await fs.mkdir(path.join(root, "directory"));
    const asyncStore = fileStore({ rootDir: root });
    const syncStore = fileStoreSync({ rootDir: root });

    const errors = [
      await captureRejected(asyncStore.readTextIfExists("directory")),
      await captureRejected(asyncStore.readJsonIfExists("directory")),
      captureThrown(() => syncStore.readTextIfExists("directory")),
      captureThrown(() => syncStore.readJsonIfExists("directory")),
    ];

    for (const error of errors) {
      expectFsSafeCode(error, "not-file");
    }
  });

  it("reports FileStore I/O failures as operational read failures", async () => {
    const root = await tempRoot("fs-safe-store-read-io-");
    await fs.writeFile(path.join(root, "value"), "content");
    const asyncStore = fileStore({ rootDir: root });
    const syncStore = fileStoreSync({ rootDir: root });
    const failure = Object.assign(new Error("read failed"), { code: "EIO" });

    vi.spyOn(fs, "open").mockRejectedValueOnce(failure);
    const asyncError = await captureRejected(asyncStore.readTextIfExists("value"));
    vi.spyOn(fsSync, "openSync").mockImplementationOnce(() => {
      throw failure;
    });
    const syncError = captureThrown(() => syncStore.readTextIfExists("value"));

    for (const error of [asyncError, syncError]) {
      expectFsSafeCode(error, "read-failed");
      expect(error).toMatchObject({ category: "operational", cause: failure });
    }
  });

  itPosix("preserves FileStore hardlink and symlink validation codes", async () => {
    const root = await tempRoot("fs-safe-store-link-read-");
    const target = path.join(root, "target");
    await fs.writeFile(target, "content");
    await fs.link(target, path.join(root, "hardlink"));
    await fs.symlink(target, path.join(root, "symlink"));
    const asyncStore = fileStore({ rootDir: root });
    const syncStore = fileStoreSync({ rootDir: root });

    for (const [key, code] of [
      ["hardlink", "hardlink"],
      ["symlink", "symlink"],
    ] as const) {
      const asyncError = await captureRejected(asyncStore.readTextIfExists(key));
      const syncError = captureThrown(() => syncStore.readTextIfExists(key));
      expectFsSafeCode(asyncError, code);
      expectFsSafeCode(syncError, code);
    }
  });

  describe.each(["sync", "async"] as const)("%s temp-workspace reads", kind => {
    let workspace: ReturnType<typeof tempWorkspaceSync> | Awaited<ReturnType<typeof tempWorkspace>>;
    beforeEach(async () => {
      const root = await tempRoot("fs-safe-workspace-contract-");
      workspace = kind === "sync"
        ? tempWorkspaceSync({ rootDir: root, prefix: "sync-" })
        : await tempWorkspace({ rootDir: root, prefix: "async-" });
    });
    afterEach(async () => { await workspace?.cleanup(); });
    const failureFrom = (name: string) => kind === "sync"
      ? captureThrown(() => workspace.read(name))
      : captureRejected(workspace.read(name) as Promise<Buffer>);

    it.each([
      ["directory", "not-file"],
      ["missing", "not-found"],
    ] as const)("classifies %s as %s", async (name, code) => {
      if (name === "directory") fsSync.mkdirSync(workspace.path(name));
      expectFsSafeCode(await failureFrom(name), code);
    });

    it("reports operational read failures with their original cause", async () => {
      await workspace.writeText("value", "content");
      const failure = Object.assign(new Error("read failed"), { code: "EIO" });
      if (kind === "sync") {
        vi.spyOn(fsSync, "openSync").mockImplementationOnce(() => { throw failure; });
      } else {
        vi.spyOn(fs, "open").mockRejectedValueOnce(failure);
      }
      const error = await failureFrom("value");
      expectFsSafeCode(error, "read-failed");
      expect(error).toMatchObject({ category: "operational", cause: failure });
    });

    itPosix("preserves hardlink and symlink validation codes", async () => {
      await workspace.writeText("target", "content");
      fsSync.linkSync(workspace.path("target"), workspace.path("hardlink"));
      fsSync.symlinkSync(workspace.path("target"), workspace.path("symlink"));
      for (const [key, code] of [["hardlink", "hardlink"], ["symlink", "symlink"]] as const) {
        expectFsSafeCode(await failureFrom(key), code);
      }
    });
  });

  it("reports a non-directory ancestor as not-file instead of an allowed missing suffix", async () => {
    const root = await tempRoot("fs-safe-symlink-parent-nondirectory-");
    const filePath = path.join(root, "file");
    const childPath = path.join(filePath, "child");
    await fs.writeFile(filePath, "content");

    const asyncError = await captureRejected(
      assertNoSymlinkParents({ rootDir: root, targetPath: childPath }),
    );
    const syncError = captureThrown(() =>
      assertNoSymlinkParentsSync({ rootDir: root, targetPath: childPath }),
    );

    expectFsSafeCode(asyncError, "not-file");
    expectFsSafeCode(syncError, "not-file");
  });
});
