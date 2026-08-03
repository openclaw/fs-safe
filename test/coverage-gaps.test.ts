import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  assertAbsolutePathInput,
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
} from "../src/absolute-path.js";
import {
  createTarEntryPreflightChecker,
  readTarEntryInfo,
} from "../src/archive-tar.js";
import { resolveArchiveKind, resolvePackedRootDir } from "../src/archive-kind.js";
import { pathExists, pathExistsSync } from "../src/fs.js";
import {
  expandHomePrefix,
  resolveEffectiveHomeDir,
  resolveHomeRelativePath,
  resolveOsHomeDir,
  resolveOsHomeRelativePath,
  resolveRequiredHomeDir,
  resolveRequiredOsHomeDir,
  resolveUserPath,
} from "../src/home-dir.js";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { createSidecarLockManager, withSidecarLock } from "../src/sidecar-lock.js";
import {
  hasNonEmptyString,
  localeLowercasePreservingWhitespace,
  lowercasePreservingWhitespace,
  normalizeFastMode,
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  normalizeOptionalThreadValue,
  normalizeStringifiedOptionalString,
  readStringValue,
  resolvePrimaryStringValue,
} from "../src/string-coerce.js";
import { movePathToTrash } from "../src/trash.js";

const { tempRoot } = useTempDirs();



describe("string coercion helpers", () => {
  it("normalizes optional string-like values", () => {
    expect(readStringValue("x")).toBe("x");
    expect(readStringValue(1)).toBeUndefined();
    expect(normalizeNullableString("  hi  ")).toBe("hi");
    expect(normalizeNullableString("   ")).toBeNull();
    expect(normalizeOptionalString(" ok ")).toBe("ok");
    expect(normalizeOptionalString(null)).toBeUndefined();
    expect(normalizeStringifiedOptionalString(42)).toBe("42");
    expect(normalizeStringifiedOptionalString(true)).toBe("true");
    expect(normalizeStringifiedOptionalString(12n)).toBe("12");
    expect(normalizeStringifiedOptionalString({})).toBeUndefined();
    expect(normalizeOptionalLowercaseString(" YES ")).toBe("yes");
    expect(normalizeLowercaseStringOrEmpty(undefined)).toBe("");
    expect(lowercasePreservingWhitespace(" A B ")).toBe(" a b ");
    expect(localeLowercasePreservingWhitespace(" A B ")).toBe(" a b ");
    expect(resolvePrimaryStringValue({ primary: " value " })).toBe("value");
    expect(resolvePrimaryStringValue({ primary: " " })).toBeUndefined();
    expect(resolvePrimaryStringValue(" direct ")).toBe("direct");
    expect(normalizeOptionalThreadValue(4.9)).toBe(4);
    expect(normalizeOptionalThreadValue(Number.NaN)).toBeUndefined();
    expect(normalizeOptionalStringifiedId(7)).toBe("7");
    expect(hasNonEmptyString(" x ")).toBe(true);
    expect(hasNonEmptyString(" ")).toBe(false);
  });

  it("parses fast mode aliases", () => {
    for (const value of [true, "on", "true", "yes", "1", "enable", "enabled", "fast"]) {
      expect(normalizeFastMode(value)).toBe(true);
    }
    for (const value of [false, "off", "false", "no", "0", "disable", "disabled", "normal"]) {
      expect(normalizeFastMode(value)).toBe(false);
    }
    expect(normalizeFastMode(null)).toBeUndefined();
    expect(normalizeFastMode("maybe")).toBeUndefined();
  });
});

describe("home directory helpers", () => {
  it("resolves explicit and OS home values", () => {
    const env = {
      OPENCLAW_HOME: "~/openclaw",
      HOME: "/home/tester",
      USERPROFILE: "/users/fallback",
    };
    expect(resolveEffectiveHomeDir(env, () => "/os/home")).toBe(path.resolve("/home/tester/openclaw"));
    expect(resolveOsHomeDir(env, () => "/os/home")).toBe(path.resolve("/home/tester"));
    expect(resolveRequiredHomeDir({}, () => "")).toBe(path.resolve(process.cwd()));
    expect(resolveRequiredOsHomeDir({}, () => "")).toBe(path.resolve(process.cwd()));
    expect(expandHomePrefix("~/file", { home: "/home/tester" })).toBe(
      path.join("/home/tester", "file"),
    );
    expect(expandHomePrefix("plain", { home: "/home/tester" })).toBe("plain");
    expect(expandHomePrefix("~other/file", { home: "/home/tester" })).toBe("~other/file");
  });

  it("resolves user paths through legacy and explicit option shapes", () => {
    const env = { OPENCLAW_HOME: "/configured", HOME: "/home/tester" };
    expect(resolveHomeRelativePath("~/state", { env })).toBe(path.resolve("/configured/state"));
    expect(resolveOsHomeRelativePath("~/state", { env })).toBe(path.resolve("/home/tester/state"));
    expect(resolveUserPath("~/state", env)).toBe(path.resolve("/configured/state"));
  });

  it("ignores unusable home values", () => {
    expect(resolveEffectiveHomeDir({ OPENCLAW_HOME: "undefined", HOME: "null" }, () => "/real"))
      .toBe(path.resolve("/real"));
    expect(resolveEffectiveHomeDir({ OPENCLAW_HOME: "~" }, () => "")).toBeUndefined();
    expect(resolveOsHomeDir({}, () => {
      throw new Error("no home");
    })).toBeUndefined();
  });
});

describe("archive kind and tar preflight helpers", () => {
  it("detects archive kinds and packed root layouts", async () => {
    expect(resolveArchiveKind("PLUGIN.ZIP")).toBe("zip");
    expect(resolveArchiveKind("pkg.tar.gz")).toBe("tar");
    expect(resolveArchiveKind("pkg.tgz")).toBe("tar");
    expect(resolveArchiveKind("pkg.txt")).toBeNull();

    const root = await tempRoot("fs-safe-packed-");
    const packageDir = path.join(root, "package");
    await fs.mkdir(packageDir);
    expect(await resolvePackedRootDir(root)).toBe(packageDir);

    await fs.rm(packageDir, { recursive: true });
    await fs.writeFile(path.join(root, "manifest.json"), "{}", "utf8");
    expect(await resolvePackedRootDir(root, { rootMarkers: [" ", "manifest.json"] })).toBe(root);

    await fs.rm(path.join(root, "manifest.json"));
    await fs.mkdir(path.join(root, "only"));
    expect(await resolvePackedRootDir(root)).toBe(path.join(root, "only"));

    await fs.mkdir(path.join(root, "second"));
    await expect(resolvePackedRootDir(root)).rejects.toThrow("unexpected archive layout");
  });

  it("normalizes tar entries and rejects unsafe entries", () => {
    expect(readTarEntryInfo({ path: "a.txt", type: "File", size: 4.9 })).toEqual({
      path: "a.txt",
      type: "File",
      size: 4,
    });
    expect(readTarEntryInfo({ path: "a.txt", type: "File", size: -1 })).toMatchObject({ size: 0 });
    expect(readTarEntryInfo(null)).toEqual({ path: "", type: "", size: 0 });

    const check = createTarEntryPreflightChecker({
      rootDir: "/tmp/extract",
      stripComponents: 1,
      limits: { maxEntries: 4, maxEntryBytes: 10, maxExtractedBytes: 20 },
    });
    expect(() => check({ path: "package/", type: "Directory", size: 0 })).not.toThrow();
    expect(() => check({ path: "package/file.txt", type: "File", size: 4 })).not.toThrow();
    expect(() => check({ path: "package/link", type: "SymbolicLink", size: 0 })).toThrow(
      "tar entry is a link",
    );
    expect(() => check({ path: "../escape", type: "File", size: 1 })).toThrow();

    const countCheck = createTarEntryPreflightChecker({
      rootDir: "/tmp/extract",
      limits: { maxEntries: 1 },
    });
    countCheck({ path: "one.txt", type: "File", size: 1 });
    expect(() => countCheck({ path: "two.txt", type: "File", size: 1 })).toThrow();
  });
});

describe("absolute path helpers", () => {
  it("validates absolute path inputs", () => {
    expect(() => assertAbsolutePathInput("")).toThrow("path is required");
    expect(() => assertAbsolutePathInput("relative")).toThrow("path must be absolute");
    expect(() => assertAbsolutePathInput(`${path.sep}tmp\0bad`)).toThrow("NUL");
    expect(assertAbsolutePathInput(path.join(path.sep, "tmp", "..", "tmp", "x"))).toBe(
      path.join(path.sep, "tmp", "x"),
    );
  });

  it("finds ancestors and resolves reads/writes", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-"));
    const nested = path.join(root, "nested");
    const filePath = path.join(nested, "file.txt");
    await fs.mkdir(nested);
    await fs.writeFile(filePath, "ok", "utf8");

    expect(await findExistingAncestor(path.join(nested, "missing", "file.txt"))).toBe(nested);
    expect(await canonicalPathFromExistingAncestor(path.join(nested, "missing", "file.txt")))
      .toBe(path.join(await fs.realpath(nested), "missing", "file.txt"));
    await expect(resolveAbsolutePathForRead(filePath)).resolves.toMatchObject({
      path: filePath,
      canonicalPath: await fs.realpath(filePath),
    });
    await expect(resolveAbsolutePathForWrite(path.join(nested, "new.txt"))).resolves.toMatchObject({
      path: path.join(nested, "new.txt"),
      parentDir: nested,
      parentExists: true,
    });
    await expectFsSafeError(resolveAbsolutePathForRead(path.join(root, "missing.txt")), "not-found");
  });

  itPosix("rejects symlinked absolute paths by default", async () => {
    const root = await tempRoot("fs-safe-absolute-link-");
    const realDir = path.join(root, "real");
    const linkDir = path.join(root, "link");
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, "file.txt"), "ok", "utf8");
    await fs.symlink(realDir, linkDir);

    await expectFsSafeError(resolveAbsolutePathForRead(path.join(linkDir, "file.txt")), "symlink");
    await expect(
      resolveAbsolutePathForRead(path.join(linkDir, "file.txt"), { symlinks: "follow" }),
    ).resolves.toMatchObject({ canonicalPath: await fs.realpath(path.join(realDir, "file.txt")) });
    await expectFsSafeError(resolveAbsolutePathForWrite(path.join(linkDir, "new.txt")), "symlink");
  });

});

describe("filesystem utility helpers", () => {
  it("checks path existence through stat semantics", async () => {
    const root = await tempRoot("fs-safe-exists-");
    const filePath = path.join(root, "file.txt");
    await fs.writeFile(filePath, "ok", "utf8");
    await expect(pathExists(filePath)).resolves.toBe(true);
    await expect(pathExists(path.join(root, "missing.txt"))).resolves.toBe(false);
    expect(pathExistsSync(filePath)).toBe(true);
    expect(pathExistsSync(path.join(root, "missing.txt"))).toBe(false);
  });

  it("moves paths with rename and copy fallback semantics", async () => {
    const root = await tempRoot("fs-safe-move-");
    const from = path.join(root, "from.txt");
    const to = path.join(root, "to.txt");
    await fs.writeFile(from, "ok", "utf8");
    await movePathWithCopyFallback({ from, to });
    await expect(fs.readFile(to, "utf8")).resolves.toBe("ok");
    await expect(fs.stat(from)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("trash helper", () => {
  it("moves allowed temp paths to trash and rejects disallowed roots", async () => {
    const root = await tempRoot("fs-safe-trash-");
    const filePath = path.join(root, "delete-me.txt");
    await fs.writeFile(filePath, "trash", "utf8");

    await expect(movePathToTrash(path.join(root, "missing.txt"), { allowedRoots: [root] }))
      .rejects
      .toThrow();
    await expect(movePathToTrash(filePath, { allowedRoots: [path.join(root, "other")] }))
      .rejects
      .toThrow("outside allowed roots");

    const dest = await movePathToTrash(filePath, { allowedRoots: [root] });
    try {
      expect(path.basename(dest)).toBe("delete-me.txt");
      expect(fsSync.existsSync(dest)).toBe(true);
      expect(fsSync.existsSync(filePath)).toBe(false);
    } finally {
      await fs.rm(path.dirname(dest), { recursive: true, force: true });
    }
  });
});

describe("sidecar lock manager", () => {
  it("acquires, queues, lists, force releases, and drains locks", async () => {
    const root = await tempRoot("fs-safe-sidecar-");
    const targetPath = path.join(root, "state.json");
    const manager = createSidecarLockManager(`coverage-${Date.now()}-${Math.random()}`);

    const lock = await manager.acquire({
      targetPath,
      staleMs: 60_000,
      metadata: { test: true },
      payload: () => ({ owner: "coverage" }),
    });
    const queued = manager.acquire({
      targetPath,
      staleMs: 60_000,
      timeoutMs: 1_000,
      retry: { minTimeout: 1, maxTimeout: 2 },
      payload: () => ({ owner: "coverage" }),
    });
    expect(manager.heldEntries()).toHaveLength(1);
    expect(manager.heldEntries()[0]?.metadata).toEqual({ test: true });
    await lock.release();
    const queuedLock = await queued;
    expect(await manager.heldEntries()[0]?.forceRelease()).toBe(true);
    await queuedLock.release();
    expect(manager.heldEntries()).toEqual([]);

    const value = await manager.withLock(
      {
        targetPath,
        staleMs: 60_000,
        payload: () => ({ owner: "coverage" }),
      },
      async () => 42,
    );
    expect(value).toBe(42);
    await manager.drain();
    manager.reset();
  });

  it("times out on stale locks without deleting them by path", async () => {
    const root = await tempRoot("fs-safe-sidecar-timeout-");
    const targetPath = path.join(root, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`coverage-timeout-${Date.now()}-${Math.random()}`);
    await fs.writeFile(lockPath, "{\"createdAt\":\"2000-01-01T00:00:00.000Z\"}\n", "utf8");

    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        timeoutMs: 1,
        retry: { retries: 0, minTimeout: 1, maxTimeout: 1 },
        payload: () => ({ owner: "coverage" }),
      }),
    ).rejects.toMatchObject({ code: "file_lock_stale" });
    await expect(fs.readFile(lockPath, "utf8")).resolves.toContain("2000");

    await fs.writeFile(lockPath, "{\"createdAt\":\"2999-01-01T00:00:00.000Z\"}\n", "utf8");
    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 60_000,
        timeoutMs: 1,
        retry: { retries: 0, minTimeout: 1, maxTimeout: 1 },
        shouldReclaim: () => false,
        payload: () => ({ owner: "coverage" }),
      }),
    ).rejects.toMatchObject({ code: "file_lock_timeout" });
    await fs.rm(lockPath, { force: true });

    await expect(
      withSidecarLock(
        targetPath,
        {
          managerKey: `coverage-wrapper-${Date.now()}-${Math.random()}`,
          staleMs: 60_000,
          payload: () => ({ owner: "coverage" }),
        },
        async () => "locked",
      ),
    ).resolves.toBe("locked");
  });
});
