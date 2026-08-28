import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { FsSafeError, type FsSafeErrorCode } from "../src/errors.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import {
  tempWorkspace,
  tempWorkspaceSync,
} from "../src/private-temp-workspace.js";
import { readSecretFileSync, tryReadSecretFileSync } from "../src/secret-file.js";
import { readSecretFile, tryReadSecretFile } from "../src/secret-read-async.js";
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

  it("does not reclassify path resolution failures as optional missing secrets", async () => {
    const failure = Object.assign(new Error("cwd unavailable"), { code: "ENOENT" });
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => { throw failure; });
    try {
      expect(captureThrown(() => readSecretFileSync("token", "token"))).toBe(failure);
      expect(captureThrown(() => tryReadSecretFileSync("token", "token"))).toBe(failure);
      expect(await captureRejected(readSecretFile("token", "token"))).toBe(failure);
      expect(await captureRejected(tryReadSecretFile("token", "token"))).toBe(failure);
    } finally {
      cwd.mockRestore();
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

  it("reports temp-workspace directory reads as not-file", async () => {
    const root = await tempRoot("fs-safe-workspace-directory-read-");
    const asyncWorkspace = await tempWorkspace({ rootDir: root, prefix: "async-" });
    const syncWorkspace = tempWorkspaceSync({ rootDir: root, prefix: "sync-" });
    try {
      await fs.mkdir(asyncWorkspace.path("directory"));
      fsSync.mkdirSync(syncWorkspace.path("directory"));

      const asyncError = await captureRejected(asyncWorkspace.read("directory"));
      const syncError = captureThrown(() => syncWorkspace.read("directory"));

      for (const error of [asyncError, syncError]) {
        expectFsSafeCode(error, "not-file");
      }
    } finally {
      await asyncWorkspace.cleanup();
      syncWorkspace.cleanup();
    }
  });

  it("reports missing temp-workspace reads as not-found", async () => {
    const root = await tempRoot("fs-safe-workspace-missing-read-");
    const asyncWorkspace = await tempWorkspace({ rootDir: root, prefix: "async-" });
    const syncWorkspace = tempWorkspaceSync({ rootDir: root, prefix: "sync-" });
    try {
      const asyncError = await captureRejected(asyncWorkspace.read("missing"));
      const syncError = captureThrown(() => syncWorkspace.read("missing"));

      for (const error of [asyncError, syncError]) {
        expectFsSafeCode(error, "not-found");
      }
    } finally {
      await asyncWorkspace.cleanup();
      syncWorkspace.cleanup();
    }
  });

  it("reports temp-workspace I/O failures as operational read failures", async () => {
    const root = await tempRoot("fs-safe-workspace-read-io-");
    const asyncWorkspace = await tempWorkspace({ rootDir: root, prefix: "async-" });
    const syncWorkspace = tempWorkspaceSync({ rootDir: root, prefix: "sync-" });
    const failure = Object.assign(new Error("read failed"), { code: "EIO" });
    try {
      await asyncWorkspace.writeText("value", "content");
      syncWorkspace.writeText("value", "content");

      vi.spyOn(fs, "open").mockRejectedValueOnce(failure);
      const asyncError = await captureRejected(asyncWorkspace.read("value"));
      vi.spyOn(fsSync, "openSync").mockImplementationOnce(() => {
        throw failure;
      });
      const syncError = captureThrown(() => syncWorkspace.read("value"));

      for (const error of [asyncError, syncError]) {
        expectFsSafeCode(error, "read-failed");
        expect(error).toMatchObject({ category: "operational", cause: failure });
      }
    } finally {
      await asyncWorkspace.cleanup();
      syncWorkspace.cleanup();
    }
  });

  itPosix("preserves temp-workspace hardlink and symlink validation codes", async () => {
    const root = await tempRoot("fs-safe-workspace-link-read-");
    const asyncWorkspace = await tempWorkspace({ rootDir: root, prefix: "async-" });
    const syncWorkspace = tempWorkspaceSync({ rootDir: root, prefix: "sync-" });
    try {
      await asyncWorkspace.writeText("target", "content");
      syncWorkspace.writeText("target", "content");
      await fs.link(asyncWorkspace.path("target"), asyncWorkspace.path("hardlink"));
      fsSync.linkSync(syncWorkspace.path("target"), syncWorkspace.path("hardlink"));
      await fs.symlink(asyncWorkspace.path("target"), asyncWorkspace.path("symlink"));
      fsSync.symlinkSync(syncWorkspace.path("target"), syncWorkspace.path("symlink"));

      for (const [key, code] of [
        ["hardlink", "hardlink"],
        ["symlink", "symlink"],
      ] as const) {
        const asyncError = await captureRejected(asyncWorkspace.read(key));
        const syncError = captureThrown(() => syncWorkspace.read(key));
        expectFsSafeCode(asyncError, code);
        expectFsSafeCode(syncError, code);
      }
    } finally {
      await asyncWorkspace.cleanup();
      syncWorkspace.cleanup();
    }
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
