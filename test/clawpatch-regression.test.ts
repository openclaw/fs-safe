import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError, expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, itDarwin, useTempDirs } from "./helpers/vitest.js";
import { prepareArchiveDestinationDir } from "../src/archive-staging.js";
import { fileStoreSync } from "../src/file-store.js";
import { writeJson, writeJsonSync } from "../src/json.js";
import { createJsonStore } from "../src/json-document-store.js";
import {
  ensureJsonDurableQueueDirs,
  moveJsonDurableQueueEntryToFailed,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import { resolveSafeRelativePath } from "../src/path.js";
import { summarizeWindowsAcl } from "../src/permissions.js";
import { configureFsSafeNative, root as openRoot } from "../src/index.js";
import { resolveExistingPathsWithinRoot, resolvePathWithinRoot } from "../src/root-paths.js";
import { readSecureFile } from "../src/secure-file.js";
import { withTimeout } from "../src/timing.js";

const { tempRoot } = useTempDirs();


afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

describe("clawpatch regression coverage", () => {
  itPosix("rejects Windows drive-letter strings on POSIX secure reads", async () => {
    const dir = await tempRoot("fs-safe-secure-drive-");
    const oldCwd = process.cwd();
    process.chdir(dir);
    try {
      const fileName = "C:\\tmp\\secret.txt";
      await fs.writeFile(fileName, "secret", { mode: 0o600 });

      await expectFsSafeError(readSecureFile({ filePath: fileName, permissions: { allowInsecure: true } }), "invalid-path");
    } finally {
      process.chdir(oldCwd);
    }
  });

  itPosix("rejects missing fallback paths under symlinked parents", async () => {
    const base = await tempRoot("fs-safe-root-paths-missing-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    await fs.mkdir(rootDir);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(rootDir, "alias"), "dir");

    const result = await resolveExistingPathsWithinRoot({
      rootDir,
      requestedPaths: ["alias/missing.txt"],
      scopeLabel: "uploads directory",
    });

    expect(result.ok).toBe(false);
  });

  it("accepts literal dot-prefixed child names in root path helpers", async () => {
    const rootDir = await tempRoot("fs-safe-dot-prefix-");
    const resolved = path.join(rootDir, "..data");

    expect(resolvePathWithinRoot({ rootDir, requestedPath: "..data", scopeLabel: "root" }))
      .toEqual({ ok: true, path: resolved });
  });

  it("resolves children when the configured root is the filesystem root", () => {
    const rootDir = path.parse(process.cwd()).root;

    expect(resolveSafeRelativePath(rootDir, "tmp")).toBe(path.join(rootDir, "tmp"));
  });

  itPosix("rejects hardlinked sync store reads by default", async () => {
    const rootDir = await tempRoot("fs-safe-sync-store-default-hardlink-");
    const filePath = path.join(rootDir, "value.txt");
    await fs.writeFile(filePath, "secret");
    await fs.link(filePath, path.join(rootDir, "alias.txt"));

    expectFsSafeErrorSync(() => fileStoreSync({ rootDir }).readTextIfExists("alias.txt"), "path-mismatch");
  });

  itPosix("rejects archive destinations swapped before realpath settles", async () => {
    const base = await tempRoot("fs-safe-archive-root-swap-");
    const dest = path.join(base, "dest");
    const outside = path.join(base, "outside");
    await fs.mkdir(dest);
    await fs.mkdir(outside);
    const realRealpath = fs.realpath;
    let swapped = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (target, options) => {
      if (!swapped && target === dest) {
        swapped = true;
        await fs.rename(dest, path.join(base, "dest-real"));
        await fs.symlink(outside, dest, "dir");
      }
      return await realRealpath(target, options as never);
    });

    await expect(prepareArchiveDestinationDir(dest)).rejects.toMatchObject({
      code: "destination-symlink-traversal",
    });
  });

  itPosix("rejects archive destinations swapped only during realpath", async () => {
    const base = await tempRoot("fs-safe-archive-root-swap-back-");
    const dest = path.join(base, "dest");
    const outside = path.join(base, "outside");
    const original = path.join(base, "dest-original");
    await fs.mkdir(dest);
    await fs.mkdir(outside);
    const realRealpath = fs.realpath;
    let swapped = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (target, options) => {
      if (!swapped && target === dest) {
        swapped = true;
        await fs.rename(dest, original);
        await fs.symlink(outside, dest, "dir");
        const result = await realRealpath(target, options as never);
        await fs.unlink(dest);
        await fs.rename(original, dest);
        return result;
      }
      return await realRealpath(target, options as never);
    });

    await expect(prepareArchiveDestinationDir(dest)).rejects.toMatchObject({
      code: "destination-symlink-traversal",
    });
  });

  it("treats domain Windows Administrators and System names as untrusted groups", () => {
    const summary = summarizeWindowsAcl(
      [
        { principal: "DOMAIN\\Administrators", rights: ["F"], rawRights: "(F)", canRead: true, canWrite: true },
        { principal: "ACME\\System", rights: ["F"], rawRights: "(F)", canRead: true, canWrite: true },
        { principal: "BUILTIN\\Administrators", rights: ["F"], rawRights: "(F)", canRead: true, canWrite: true },
        { principal: "AUTORITÉ NT\\Système", rights: ["F"], rawRights: "(F)", canRead: true, canWrite: true },
      ],
      {},
    );

    expect(summary.untrustedGroup.map((entry) => entry.principal)).toEqual([
      "DOMAIN\\Administrators",
      "ACME\\System",
    ]);
    expect(summary.trusted.map((entry) => entry.principal)).toEqual([
      "BUILTIN\\Administrators",
      "AUTORITÉ NT\\Système",
    ]);
  });

  it("rejects throwing timeout factories through the returned promise", async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 1, {
        createError: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("rejects top-level undefined JSON without replacing existing files", async () => {
    const rootDir = await tempRoot("fs-safe-json-undefined-");
    const syncPath = path.join(rootDir, "sync.json");
    const asyncPath = path.join(rootDir, "async.json");
    const queuePath = path.join(rootDir, "queue.json");
    writeJsonSync(syncPath, { ok: true });
    await writeJson(asyncPath, { ok: true });
    await fs.writeFile(queuePath, "{\"ok\":true}\n");

    expect(() => writeJsonSync(syncPath, undefined)).toThrow("not representable");
    await expect(writeJson(asyncPath, undefined)).rejects.toThrow("not representable");
    await expect(
      writeJsonDurableQueueEntry({
        filePath: queuePath,
        entry: undefined,
        tempPrefix: ".queue.",
      }),
    ).rejects.toThrow("not representable");
    expect(fsSync.readFileSync(syncPath, "utf8")).toContain("\"ok\": true");
    await expect(fs.readFile(asyncPath, "utf8")).resolves.toContain("\"ok\": true");
    await expect(fs.readFile(queuePath, "utf8")).resolves.toBe("{\"ok\":true}\n");
  });

  it("preserves JSON store null as a stored value", async () => {
    let stored: number | null | undefined = null;
    const store = createJsonStore<number | null>({
      filePath: "/tmp/state.json",
      readIfExists: async () => stored,
      readRequired: async () => {
        if (stored === undefined) {
          throw new Error("missing");
        }
        return stored;
      },
      write: async (value) => {
        stored = value;
      },
    });

    await expect(store.read()).resolves.toBeNull();
    await expect(store.readOr(1)).resolves.toBeNull();
    await expect(store.updateOr(1, (value) => (value === null ? 2 : value))).resolves.toBe(2);
  });

  itPosix("tightens pre-existing durable queue directory modes", async () => {
    const rootDir = await tempRoot("fs-safe-queue-mode-");
    const queueDir = path.join(rootDir, "queue");
    const failedDir = path.join(rootDir, "failed");
    await fs.mkdir(queueDir, { mode: 0o777 });
    await fs.mkdir(failedDir, { mode: 0o777 });
    await fs.chmod(queueDir, 0o777);
    await fs.chmod(failedDir, 0o777);

    await ensureJsonDurableQueueDirs({ queueDir, failedDir });

    expect((await fs.stat(queueDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(failedDir)).mode & 0o777).toBe(0o700);
  });

  it("creates durable queue directories under a missing shared parent", async () => {
    const rootDir = await tempRoot("fs-safe-queue-missing-parent-");
    const queueDir = path.join(rootDir, "state", "queue");
    const failedDir = path.join(rootDir, "state", "failed");

    await ensureJsonDurableQueueDirs({ queueDir, failedDir });

    expect((await fs.stat(queueDir)).isDirectory()).toBe(true);
    expect((await fs.stat(failedDir)).isDirectory()).toBe(true);
  });

  itDarwin("allows durable queue dirs below a symlinked missing prefix", async () => {
    const prefix = "/tmp";
    if (!(await fs.lstat(prefix)).isSymbolicLink()) {
      return;
    }
    const rootDir = path.join(prefix, `fs-safe-queue-prefix-${process.pid}-${Date.now()}`);
    const queueDir = path.join(rootDir, "queue");
    const failedDir = path.join(rootDir, "failed");
    try {
      await ensureJsonDurableQueueDirs({ queueDir, failedDir });

      expect((await fs.stat(queueDir)).isDirectory()).toBe(true);
      expect((await fs.stat(failedDir)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  itDarwin("allows durable queue sibling dirs directly below /tmp", async () => {
    const prefix = "/tmp";
    if (!(await fs.lstat(prefix)).isSymbolicLink()) {
      return;
    }
    const queueDir = path.join(prefix, `fs-safe-queue-${process.pid}-${Date.now()}`);
    const failedDir = path.join(prefix, `fs-safe-failed-${process.pid}-${Date.now()}`);
    try {
      await ensureJsonDurableQueueDirs({ queueDir, failedDir });

      expect((await fs.stat(queueDir)).isDirectory()).toBe(true);
      expect((await fs.stat(failedDir)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
      await fs.rm(failedDir, { recursive: true, force: true });
    }
  });

  itPosix("rejects symlinked durable queue directories without chmoding targets", async () => {
    const rootDir = await tempRoot("fs-safe-queue-symlink-mode-");
    const outsideDir = path.join(rootDir, "outside");
    const queueDir = path.join(rootDir, "queue");
    const failedDir = path.join(rootDir, "failed");
    await fs.mkdir(outsideDir, { mode: 0o755 });
    await fs.mkdir(failedDir);
    await fs.chmod(outsideDir, 0o755);
    await fs.symlink(outsideDir, queueDir, "dir");

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toBeTruthy();
    expect((await fs.stat(outsideDir)).mode & 0o777).toBe(0o755);
  });

  itPosix("rejects symlinked durable queue parents before mkdir", async () => {
    const rootDir = await tempRoot("fs-safe-queue-symlink-parent-");
    const outsideDir = path.join(rootDir, "outside");
    const queueParent = path.join(rootDir, "link");
    const queueDir = path.join(queueParent, "queue");
    const failedDir = path.join(rootDir, "failed");
    await fs.mkdir(outsideDir, { mode: 0o755 });
    await fs.mkdir(failedDir);
    await fs.chmod(outsideDir, 0o755);
    await fs.symlink(outsideDir, queueParent, "dir");

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toBeTruthy();
    await expect(fs.lstat(path.join(outsideDir, "queue"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fs.stat(outsideDir)).mode & 0o777).toBe(0o755);
  });

  itPosix("rejects missing durable queue dirs under shared symlink parents", async () => {
    const rootDir = await tempRoot("fs-safe-queue-shared-symlink-parent-");
    const outsideDir = path.join(rootDir, "outside");
    const queueParent = path.join(rootDir, "link");
    const queueDir = path.join(queueParent, "missing", "state", "queue");
    const failedDir = path.join(queueParent, "missing", "state", "failed");
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, queueParent, "dir");

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toBeTruthy();
    await expect(fs.lstat(path.join(outsideDir, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  itPosix("rejects existing durable queue directories under symlinked parents", async () => {
    const rootDir = await tempRoot("fs-safe-queue-existing-symlink-parent-");
    const outsideDir = path.join(rootDir, "outside");
    const queueParent = path.join(rootDir, "link");
    const queueDir = path.join(queueParent, "queue");
    const failedDir = path.join(rootDir, "failed");
    await fs.mkdir(path.join(outsideDir, "queue"), { mode: 0o755, recursive: true });
    await fs.mkdir(failedDir);
    await fs.symlink(outsideDir, queueParent, "dir");
    const originalMode = (await fs.stat(path.join(outsideDir, "queue"))).mode & 0o777;

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toBeTruthy();
    expect((await fs.stat(path.join(outsideDir, "queue"))).mode & 0o777).toBe(originalMode);
  });

  itPosix("rejects shared existing durable queue dirs under symlinked parents", async () => {
    const rootDir = await tempRoot("fs-safe-queue-shared-existing-symlink-parent-");
    const outsideDir = path.join(rootDir, "outside");
    const queueParent = path.join(rootDir, "link");
    const queueDir = path.join(queueParent, "state", "queue");
    const failedDir = path.join(queueParent, "state", "failed");
    await fs.mkdir(path.join(outsideDir, "state", "queue"), { mode: 0o755, recursive: true });
    await fs.mkdir(path.join(outsideDir, "state", "failed"), { mode: 0o755, recursive: true });
    await fs.symlink(outsideDir, queueParent, "dir");
    const originalQueueMode = (await fs.stat(path.join(outsideDir, "state", "queue"))).mode & 0o777;
    const originalFailedMode = (await fs.stat(path.join(outsideDir, "state", "failed"))).mode & 0o777;

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toBeTruthy();
    expect((await fs.stat(path.join(outsideDir, "state", "queue"))).mode & 0o777).toBe(originalQueueMode);
    expect((await fs.stat(path.join(outsideDir, "state", "failed"))).mode & 0o777).toBe(originalFailedMode);
  });

  itPosix("rejects symlinked durable queue failed directories during moves", async () => {
    const rootDir = await tempRoot("fs-safe-queue-failed-symlink-");
    const queueDir = path.join(rootDir, "queue");
    const outsideDir = path.join(rootDir, "outside");
    const failedDir = path.join(rootDir, "failed");
    await fs.mkdir(queueDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(queueDir, "entry-1.json"), "{\"ok\":true}\n");
    await fs.symlink(outsideDir, failedDir, "dir");

    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "entry-1" }),
    ).rejects.toBeTruthy();
    await expect(fs.lstat(path.join(outsideDir, "entry-1.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(queueDir, "entry-1.json"), "utf8")).resolves.toContain(
      "\"ok\":true",
    );
  });

  itPosix("uses atomic no-clobber writes for root create", async () => {
    configureFsSafeNative({ mode: "auto" });
    const rootDir = await tempRoot("fs-safe-root-create-noclobber-");
    const scoped = await openRoot(rootDir);
    await scoped.create("created.txt", "first");

    await expectFsSafeError(scoped.create("created.txt", "second"), "already-exists");
    await expect(fs.readFile(path.join(rootDir, "created.txt"), "utf8")).resolves.toBe("first");
  });

  itPosix("keeps already-exists for no-clobber creates in read-only parents", async () => {
    configureFsSafeNative({ mode: "auto" });
    const rootDir = await tempRoot("fs-safe-root-create-existing-readonly-");
    const parent = path.join(rootDir, "readonly");
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "created.txt"), "first");
    await fs.chmod(parent, 0o555);
    const scoped = await openRoot(rootDir);

    try {
      await expectFsSafeError(scoped.create("readonly/created.txt", "second"), "already-exists");
    } finally {
      await fs.chmod(parent, 0o755).catch(() => undefined);
    }
  });

  itPosix("rolls back no-clobber move links when source unlink fails", async () => {
    configureFsSafeNative({ mode: "auto" });
    const rootDir = await tempRoot("fs-safe-root-move-link-rollback-");
    const srcDir = path.join(rootDir, "src");
    const dstDir = path.join(rootDir, "dst");
    await fs.mkdir(srcDir);
    await fs.mkdir(dstDir);
    const sourcePath = path.join(srcDir, "file.txt");
    const destinationPath = path.join(dstDir, "file.txt");
    await fs.writeFile(sourcePath, "payload");
    await fs.chmod(srcDir, 0o555);
    const scoped = await openRoot(rootDir);

    try {
      await expect(scoped.move("src/file.txt", "dst/file.txt")).rejects.toBeTruthy();
      await expect(fs.lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(sourcePath)).nlink).toBe(1);
    } finally {
      await fs.chmod(srcDir, 0o755).catch(() => undefined);
    }
  });

  itPosix("rejects no-clobber directory moves instead of racing rename", async () => {
    for (const mode of ["auto", "off"] as const) {
      configureFsSafeNative({ mode });
      const rootDir = await tempRoot(`fs-safe-root-move-dir-noclobber-${mode}-`);
      await fs.mkdir(path.join(rootDir, "from"));
      const scoped = await openRoot(rootDir);

      await expect(scoped.move("from", "to")).rejects.toMatchObject({ code: "invalid-path" });
      await expect(fs.lstat(path.join(rootDir, "from"))).resolves.toBeTruthy();
      await expect(fs.lstat(path.join(rootDir, "to"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });


  it("cleans no-clobber fallback destinations after a write failure", async () => {
    const rootDir = await tempRoot("fs-safe-root-create-copy-fail-");
    configureFsSafeNative({ mode: "off" });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (path.basename(String(args[0])) === "created.txt") {
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(
          Object.assign(new Error("test write failure"), { code: "EIO" }),
        );
      }
      return handle;
    });
    const scoped = await openRoot(rootDir);

    await expect(scoped.create("created.txt", "payload")).rejects.toBeTruthy();
    await expect(fs.lstat(path.join(rootDir, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
