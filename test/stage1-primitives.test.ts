import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  isHardlinkFallbackError,
  publishFileExclusive,
} from "../src/durability.js";
import {
  acquireFileLock,
  acquireFileLockSync,
  withFileLockSync,
} from "../src/file-lock.js";
import { root } from "../src/root.js";
import {
  createSecretFileAtomic,
  readSecretFile,
  tryReadSecretFile,
} from "../src/secret.js";
import { tempWorkspace } from "../src/temp.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { FsSafeError } from "../src/errors.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const { tempDirs, tempRoot } = useTempDirs();


afterEach(async () => {
  configureFsSafeNative({ mode: "auto" });
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

describe("exclusive file publication", () => {
  it("closes the source handle when publication parent pinning fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-publish-parent-failure-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "missing", "target");
    await fs.writeFile(sourcePath, "content");
    const open = fs.open.bind(fs);
    let opened = 0;
    let closed = 0;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      opened += 1;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        closed += 1;
        await close();
      });
      return handle;
    });

    await expect(
      publishFileExclusive({ sourcePath, targetPath, strategy: "link-required" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
  });

  it("publishes by hardlink without clobbering an existing target", async () => {
    const directory = await tempRoot("fs-safe-publish-link-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "content");
    const result = await publishFileExclusive({ sourcePath, targetPath, strategy: "link-required" });
    expect(result.method).toBe("hardlink");
    expect(result.directorySync.status).toMatch(/^(?:synced|unsupported)$/u);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("content");
    await expect(
      publishFileExclusive({ sourcePath, targetPath, strategy: "link-or-copy" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("falls back only for classified hardlink errors and copies from the pinned source", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-publish-copy-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "copy-content");
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "EXDEV" }));
    const result = await publishFileExclusive({ sourcePath, targetPath, strategy: "link-or-copy" });
    expect(result.method).toBe("exclusive-copy");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("copy-content");
    expect(isHardlinkFallbackError(Object.assign(new Error(), { code: "EOPNOTSUPP" }))).toBe(true);
    expect(isHardlinkFallbackError(Object.assign(new Error(), { code: "EIO" }))).toBe(false);
  });

  it.each(["removed", "preserved", "unknown"] as const)(
    "reports %s cleanup after a post-hardlink failure",
    async (cleanup) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-publish-${cleanup}-`);
      const sourcePath = path.join(directory, "source");
      const targetPath = path.join(directory, "target");
      const originalLinkPath = path.join(directory, "original-link");
      await fs.writeFile(sourcePath, "source-content");

      __setFsSafeTestHooksForTest({
        async afterPublishTargetCreated(method, createdPath) {
          expect(method).toBe("hardlink");
          expect(createdPath).toBe(targetPath);
          if (cleanup === "preserved") {
            await fs.rename(targetPath, originalLinkPath);
            await fs.writeFile(targetPath, "replacement-content");
          }
          throw new Error("post-publication guard failed");
        },
      });
      const rm =
        cleanup === "unknown"
          ? vi
              .spyOn(fs, "rm")
              .mockRejectedValueOnce(Object.assign(new Error("cleanup denied"), { code: "EACCES" }))
          : undefined;

      try {
        await expect(
          publishFileExclusive({ sourcePath, targetPath, strategy: "link-required" }),
        ).rejects.toSatisfy((error: unknown) => {
          expect(error).toBeInstanceOf(FsSafeError);
          expect(error).toMatchObject({
            code: "helper-failed",
            details: {
              phase: "hardlink-verify",
              targetCreated: true,
              targetIdentity: { dev: expect.any(Number), ino: expect.any(Number) },
              cleanup,
            },
          });
          return true;
        });
      } finally {
        rm?.mockRestore();
      }

      if (cleanup === "removed") {
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else if (cleanup === "preserved") {
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("replacement-content");
        await expect(fs.readFile(originalLinkPath, "utf8")).resolves.toBe("source-content");
      } else {
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("source-content");
      }
    },
  );

  it.each([
    ["rollback", "removed"],
    ["preserve", "preserved"],
  ] as const)(
    "%s sync-failure policy reports %s cleanup for an unchanged target",
    async (onSyncFailure, cleanup) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-publish-sync-${onSyncFailure}-`);
      const sourcePath = path.join(directory, "source");
      const targetPath = path.join(directory, "target");
      await fs.writeFile(sourcePath, "complete-archive");
      __setFsSafeTestHooksForTest({
        beforePublishDirectorySync(method, createdPath) {
          expect(method).toBe("hardlink");
          expect(createdPath).toBe(targetPath);
          throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
        },
      });

      await expect(
        publishFileExclusive({
          sourcePath,
          targetPath,
          strategy: "link-required",
          onSyncFailure,
        }),
      ).rejects.toMatchObject({
        code: "helper-failed",
        details: {
          phase: "directory-sync",
          targetCreated: true,
          cleanup,
          directorySync: { status: "failed", code: "EIO" },
        },
      });

      if (onSyncFailure === "rollback") {
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("complete-archive");
      }
    },
  );

  it("preserves a replacement target when its identity changes during sync failure", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-publish-sync-drift-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    const originalLinkPath = path.join(directory, "original-link");
    await fs.writeFile(sourcePath, "complete-archive");
    __setFsSafeTestHooksForTest({
      async beforePublishDirectorySync() {
        await fs.rename(targetPath, originalLinkPath);
        await fs.writeFile(targetPath, "replacement");
        throw Object.assign(new Error("target identity changed"), { code: "path-mismatch" });
      },
    });

    await expect(
      publishFileExclusive({
        sourcePath,
        targetPath,
        strategy: "link-required",
        onSyncFailure: "rollback",
      }),
    ).rejects.toMatchObject({
      details: {
        phase: "directory-sync",
        targetCreated: true,
        cleanup: "preserved",
        directorySync: { status: "failed", code: "path-mismatch" },
      },
    });
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(originalLinkPath, "utf8")).resolves.toBe(
      "complete-archive",
    );
  });

  itPosix("detects parent replacement inside the shared directory-sync boundary", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-publish-parent-drift-");
    const movedDirectory = `${directory}.moved`;
    tempDirs.push(movedDirectory);
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "complete-archive");
    __setFsSafeTestHooksForTest({
      async beforePublishDirectorySync() {
        await fs.rename(directory, movedDirectory);
        await fs.mkdir(directory);
        await fs.writeFile(targetPath, "replacement");
      },
    });

    await expect(
      publishFileExclusive({
        sourcePath,
        targetPath,
        strategy: "link-required",
        onSyncFailure: "rollback",
      }),
    ).rejects.toMatchObject({
      details: {
        phase: "directory-sync",
        cleanup: "preserved",
        directorySync: { status: "failed", code: "path-mismatch" },
      },
    });
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(path.join(movedDirectory, "target"), "utf8")).resolves.toBe(
      "complete-archive",
    );
  });
});

describe("secret file additions", () => {
  it("creates once and supports strict and try-style async reads", async () => {
    const directory = await tempRoot("fs-safe-secret-create-");
    const filePath = path.join(directory, "private", "token");
    await createSecretFileAtomic({ rootDir: directory, filePath, content: " token\n" });
    await expect(readSecretFile(filePath, "token")).resolves.toBe("token");
    await expect(tryReadSecretFile(path.join(directory, "missing"), "token")).resolves.toBeUndefined();
    await expectFsSafeError(createSecretFileAtomic({ rootDir: directory, filePath, content: "replacement" }), "secret-exists");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(" token\n");
  });
});

describe("file lock additions", () => {
  it("supports synchronous acquisition without the manager queue", async () => {
    const directory = await tempRoot("fs-safe-lock-sync-");
    const targetPath = path.join(directory, "state.json");
    const lock = acquireFileLockSync(targetPath, {
      payload: () => ({ createdAt: new Date().toISOString() }),
      timeoutMs: 0,
      retry: { retries: 0 },
    });
    expect(lock.verifyStillHeld()).toBe(true);
    expect(() =>
      withFileLockSync(
        targetPath,
        { payload: () => ({}), timeoutMs: 0, retry: { retries: 0 } },
        () => undefined,
      ),
    ).toThrow(/timeout/u);
    lock.release();
    expect(fsSync.existsSync(lock.lockPath)).toBe(false);
  });

  it("bounds async sidecars through Root and reports compromised ownership", async () => {
    const directory = await tempRoot("fs-safe-lock-root-");
    const lockDirectory = path.join(directory, "locks");
    await fs.mkdir(lockDirectory);
    const lockRoot = await root(lockDirectory);
    const lockPath = path.join(lockDirectory, "state.lock");
    let compromised = false;
    const lock = await acquireFileLock(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload: () => ({ createdAt: new Date().toISOString() }),
      compromiseCheckIntervalMs: 5,
      onCompromised: () => {
        compromised = true;
      },
    });
    expect(await lock.verifyStillHeld()).toBe(true);
    await fs.writeFile(lockPath, "replacement");
    await vi.waitFor(() => expect(compromised).toBe(true));
    expect(await lock.verifyStillHeld()).toBe(false);
    await lock.release();
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("replacement");

    await expectFsSafeError(acquireFileLock(path.join(directory, "other.json"), {
        lockPath: path.join(directory, "outside.lock"),
        lockRoot,
        payload: () => ({}),
      }), "outside-workspace");
  });

  it("lets application parsers drive guarded legacy payload reclaim", async () => {
    const directory = await tempRoot("fs-safe-lock-legacy-");
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    await fs.writeFile(lockPath, "pid=123\n");
    const seen: unknown[] = [];
    const lock = await acquireFileLock(targetPath, {
      lockPath,
      staleRecovery: "remove-if-unchanged",
      staleMs: 1,
      payload: () => ({ createdAt: new Date().toISOString() }),
      parsePayload: (raw) => ({ pid: Number(raw.match(/\d+/u)?.[0]) }),
      shouldReclaim: ({ payload }) => {
        seen.push(payload);
        return true;
      },
      shouldRemoveStaleLock: ({ payload }) => {
        seen.push(payload);
        return true;
      },
    });
    expect(seen).toEqual([{ pid: 123 }, { pid: 123 }]);
    await lock.release();
  });
});

describe("root walk and temp receipts", () => {
  it("walks within a Root and reports or throws on budgets", async () => {
    const directory = await tempRoot("fs-safe-root-walk-");
    await fs.mkdir(path.join(directory, "nested"));
    await fs.writeFile(path.join(directory, "nested", "value.txt"), "value");
    const capability = await root(directory);
    const entries = [];
    for await (const entry of capability.walk("", {
      maxDepth: 0,
      maxEntries: 10,
      symlinkPolicy: "skip",
    })) {
      entries.push(entry);
    }
    expect(entries).toEqual([
      { relativePath: "nested", kind: "directory", size: expect.any(Number) },
      { relativePath: "nested", kind: "truncated", size: 0 },
    ]);
    await expectFsSafeError((async () => {
      for await (const _entry of capability.walk("", {
        maxEntries: 0,
        symlinkPolicy: "skip",
        limitBehavior: "throw",
      })) {
        // Consume the iterator.
      }
    })(), "too-large");
  });

  itPosix("follows only symlinks that remain inside the walk root", async () => {
    const directory = await tempRoot("fs-safe-root-walk-links-");
    const outside = await tempRoot("fs-safe-root-walk-outside-");
    await fs.mkdir(path.join(directory, "real"));
    await fs.writeFile(path.join(directory, "real", "value"), "value");
    await fs.symlink(path.join(directory, "real"), path.join(directory, "inside"));
    await fs.symlink(outside, path.join(directory, "outside"));
    const capability = await root(directory);
    const seen: string[] = [];
    await expect(async () => {
      for await (const entry of capability.walk("", {
        symlinkPolicy: "follow-within-root",
      })) {
        seen.push(entry.relativePath);
      }
    }).rejects.toThrow(/root walk/u);
    expect(seen).toContain("inside");
    expect(seen).not.toContain("outside/value");
  });

  it("does not dispose a replacement temp workspace", async () => {
    const directory = await tempRoot("fs-safe-temp-receipt-");
    const workspace = await tempWorkspace({ rootDir: directory, prefix: "work-" });
    expect(workspace.identity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
    const original = `${workspace.dir}.original`;
    await fs.rename(workspace.dir, original);
    await fs.mkdir(workspace.dir);
    await fs.writeFile(path.join(workspace.dir, "replacement"), "keep");
    await expect(workspace.cleanup()).resolves.toBe("identity-mismatch");
    await expect(fs.readFile(path.join(workspace.dir, "replacement"), "utf8")).resolves.toBe("keep");
  });
});
