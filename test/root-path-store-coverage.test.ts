import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError, expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  canonicalPathFromExistingAncestor,
  ensureAbsoluteDirectory,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
} from "../src/absolute-path.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import {
  ensureDirectoryWithinRoot,
  pathScope,
  resolveExistingPathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from "../src/root-paths.js";

const { tempDirs, tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("absolute path failure coverage", () => {
  it("classifies root lookup errno and preserves unexpected failures", async () => {
    const target = path.join(path.parse(process.cwd()).root, "missing");
    const realLstat = fs.lstat.bind(fs);

    for (const [errno, code] of [["ENOENT", "not-found"], ["ENOTDIR", "not-file"]] as const) {
      vi.spyOn(fs, "lstat").mockRejectedValueOnce(
        Object.assign(new Error(errno), { code: errno }),
      );
      await expect(ensureAbsoluteDirectory(target, { scopeLabel: "test root" }))
        .resolves.toMatchObject({ ok: false, code });
      vi.restoreAllMocks();
    }

    vi.spyOn(fs, "lstat").mockImplementationOnce(async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }).mockImplementation(realLstat);
    await expect(ensureAbsoluteDirectory(target, { scopeLabel: "test root" }))
      .rejects.toMatchObject({ code: "EACCES" });
  });

  it("rechecks an EEXIST mkdir race and rejects a file won by the racer", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-eexist-"));
    const target = path.join(root, "raced");
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
      if (String(candidate) === target) {
        await fs.writeFile(target, "attacker");
        throw Object.assign(new Error("already exists"), { code: "EEXIST" });
      }
      return await realMkdir(candidate, options);
    });

    await expect(ensureAbsoluteDirectory(target, { scopeLabel: "test root" }))
      .resolves.toMatchObject({ ok: false, code: "not-file" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("attacker");
  });

  it("returns write metadata for a missing parent and permits explicit symlink following", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-write-"));
    const missing = path.join(root, "missing", "value.txt");
    await expect(resolveAbsolutePathForWrite(missing, { symlinks: "follow" }))
      .resolves.toMatchObject({
        path: missing,
        parentDir: path.dirname(missing),
        parentExists: false,
      });

    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "realpath").mockRejectedValueOnce(denied);
    await expect(resolveAbsolutePathForRead(path.join(root, "value.txt"))).rejects.toBe(denied);
  });

  itPosix("reclassifies a directory guard race from the filesystem state", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-guard-race-"));
    const outside = await fs.realpath(await tempRoot("fs-safe-absolute-guard-race-outside-"));
    const original = `${root}-original`;
    tempDirs.push(original);
    const target = path.join(root, "missing");
    const realLstat = fs.lstat.bind(fs);
    let rootLookups = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      if (String(candidate) === root && ++rootLookups === 2) {
        await fs.rename(root, original);
        await fs.symlink(outside, root, "dir");
      }
      return await realLstat(candidate, options);
    });

    await expect(ensureAbsoluteDirectory(target, { scopeLabel: "test root" }))
      .resolves.toMatchObject({ ok: false, code: "symlink" });
    await expect(fs.lstat(path.join(outside, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps a guard target that vanishes after validation and preserves segment I/O errors", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-guard-missing-"));
    const file = path.join(root, "file.txt");
    const target = path.join(root, "missing");
    await fs.writeFile(file, "not a directory");
    const fileStat = await fs.lstat(file);
    const realLstat = fs.lstat.bind(fs);
    let rootLookups = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      if (String(candidate) === root) {
        rootLookups += 1;
        if (rootLookups === 2) return fileStat;
        if (rootLookups === 3) {
          throw Object.assign(new Error("vanished"), { code: "ENOENT" });
        }
      }
      return await realLstat(candidate, options);
    });
    await expect(ensureAbsoluteDirectory(target, { scopeLabel: "test root" }))
      .resolves.toMatchObject({ ok: false, code: "not-found" });

    vi.restoreAllMocks();
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      if (String(candidate) === target) throw denied;
      return await realLstat(candidate, options);
    });
    await expect(ensureAbsoluteDirectory(target, { scopeLabel: "test root" })).rejects.toBe(denied);
    vi.restoreAllMocks();
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(denied);
    await expect(canonicalPathFromExistingAncestor(target)).rejects.toBe(denied);
  });

  it("rejects a non-directory filesystem root and tolerates canonicalization loss on write", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-absolute-root-check-"));
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "file");
    const fileStat = await fs.lstat(file);
    vi.spyOn(fs, "lstat").mockResolvedValueOnce(fileStat);
    await expect(ensureAbsoluteDirectory(path.join(root, "missing"), { scopeLabel: "test root" }))
      .resolves.toMatchObject({ ok: false, code: "not-file" });

    vi.restoreAllMocks();
    const target = path.join(root, "new.txt");
    const realRealpath = fs.realpath.bind(fs);
    let rejected = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate, options) => {
      if (!rejected && String(candidate) === root) {
        rejected = true;
        throw Object.assign(new Error("canonicalization unavailable"), { code: "EACCES" });
      }
      return await realRealpath(candidate, options);
    });
    await expect(resolveAbsolutePathForWrite(target)).resolves.toMatchObject({ path: target });
  });
});

describe("root path canonical boundary coverage", () => {
  it("rejects untrusted roots, parents, and existing non-file targets", async () => {
    const root = await tempRoot("fs-safe-root-path-invalid-");
    const rootFile = path.join(root, "root-file");
    const directoryTarget = path.join(root, "directory-target");
    const hardlinkTarget = path.join(root, "hardlink.txt");
    await fs.writeFile(rootFile, "not a directory");
    await fs.mkdir(directoryTarget);
    await fs.writeFile(hardlinkTarget, "linked");
    await fs.link(hardlinkTarget, path.join(root, "hardlink-alias.txt"));

    await expect(resolveWritablePathWithinRoot({
      rootDir: rootFile,
      requestedPath: "child.txt",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
    await expect(resolveWritablePathWithinRoot({
      rootDir: root,
      requestedPath: "missing/child.txt",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
    await expect(resolveWritablePathWithinRoot({
      rootDir: root,
      requestedPath: "root-file/child.txt",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
    await expect(resolveWritablePathWithinRoot({
      rootDir: root,
      requestedPath: "directory-target",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
    await expect(resolveWritablePathWithinRoot({
      rootDir: root,
      requestedPath: "hardlink.txt",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
    await expect(resolveWritablePathWithinRoot({
      rootDir: root,
      requestedPath: "../escape.txt",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
  });

  itPosix("rejects writable symlinks and directory creation through an untrusted root", async () => {
    const container = await tempRoot("fs-safe-root-path-symlink-");
    const root = path.join(container, "root");
    const outside = path.join(container, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "value.txt"), "outside");
    await fs.symlink(path.join(outside, "value.txt"), path.join(root, "link.txt"));
    await expect(resolveWritablePathWithinRoot({
      rootDir: root,
      requestedPath: "link.txt",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });

    await fs.symlink(outside, path.join(root, "directory-link"), "dir");
    await expect(ensureDirectoryWithinRoot({
      rootDir: root,
      requestedPath: "directory-link/child",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
    await expect(ensureDirectoryWithinRoot({
      rootDir: path.join(outside, "value.txt"),
      requestedPath: "child",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
  });

  it("rechecks an EEXIST directory-creation race", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-root-path-eexist-"));
    const target = path.join(root, "created");
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (candidate, options) => {
      if (String(candidate) === target) {
        await realMkdir(candidate, options);
        throw Object.assign(new Error("already exists"), { code: "EEXIST" });
      }
      return await realMkdir(candidate, options);
    });

    await expect(ensureDirectoryWithinRoot({
      rootDir: root,
      requestedPath: "created",
      scopeLabel: "store",
    })).resolves.toEqual({ ok: true, path: target });
    await expect(fs.lstat(target)).resolves.toMatchObject({});
  });

  itPosix("accepts an absolute alias only when its canonical file remains in root", async () => {
    const container = await tempRoot("fs-safe-root-path-alias-");
    const root = path.join(container, "root");
    const alias = path.join(container, "alias");
    const file = path.join(root, "value.txt");
    await fs.mkdir(root);
    await fs.writeFile(file, "inside");
    await fs.symlink(root, alias, "dir");

    await expect(resolveStrictExistingPathsWithinRoot({
      rootDir: root,
      requestedPaths: [path.join(alias, "value.txt")],
      scopeLabel: "store",
    })).resolves.toEqual({ ok: true, paths: [await fs.realpath(file)] });

    await expect(resolveStrictExistingPathsWithinRoot({
      rootDir: root,
      requestedPaths: [path.join(alias, "missing.txt")],
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
  });

  it("keeps missing paths lexical when the root itself is absent", async () => {
    const container = await tempRoot("fs-safe-root-path-missing-root-");
    const missingRoot = path.join(container, "missing-root");
    await expect(resolveExistingPathsWithinRoot({
      rootDir: missingRoot,
      requestedPaths: ["nested/value.txt"],
      scopeLabel: "store",
    })).resolves.toEqual({
      ok: true,
      paths: [path.join(missingRoot, "nested", "value.txt")],
    });
  });

  it("exercises every path-scope operation and rejects a file directory component", async () => {
    const root = await tempRoot("fs-safe-path-scope-");
    await fs.writeFile(path.join(root, "file.txt"), "value");
    await fs.writeFile(path.join(root, "blocking"), "not a directory");
    const scope = pathScope(root, { label: "store" });

    expect(scope.resolve("file.txt")).toEqual({ ok: true, path: path.join(root, "file.txt") });
    expect(scope.resolveAll(["file.txt"])).toEqual({ ok: true, paths: [path.join(root, "file.txt")] });
    await expect(scope.existing(["missing.txt"])).resolves.toEqual({
      ok: true,
      paths: [path.join(root, "missing.txt")],
    });
    await expect(scope.files(["file.txt"])).resolves.toMatchObject({ ok: true });
    await expect(scope.writable("file.txt")).resolves.toEqual({
      ok: true,
      path: path.join(root, "file.txt"),
    });
    await expect(scope.ensureDir("created/nested", { mode: 0o700 })).resolves.toEqual({
      ok: true,
      path: path.join(root, "created", "nested"),
    });
    await expect(ensureDirectoryWithinRoot({
      rootDir: root,
      requestedPath: "blocking/child",
      scopeLabel: "store",
    })).resolves.toMatchObject({ ok: false });
  });
});

describe("file store error and private-stream coverage", () => {
  it("enforces the private stream limit at the boundary and one byte past", async () => {
    const root = await tempRoot("fs-safe-private-stream-");
    const store = fileStore({ rootDir: root, private: true, maxBytes: 4 });

    await expect(store.writeStream("exact.txt", Readable.from(["12", Buffer.from("34")])))
      .resolves.toBe(path.join(root, "exact.txt"));
    await expect(fs.readFile(path.join(root, "exact.txt"), "utf8")).resolves.toBe("1234");
    await expectFsSafeError(
      store.writeStream("large.txt", Readable.from(["12", Buffer.from("345")])),
      "too-large",
    );
    await expect(fs.lstat(path.join(root, "large.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects private sync writes over directories and cleans a failed atomic temp", async () => {
    const root = await tempRoot("fs-safe-sync-store-failure-");
    const store = fileStoreSync({ rootDir: root, private: true });
    await fs.mkdir(path.join(root, "directory"));
    expectFsSafeErrorSync(() => store.writeText("directory", "nope"), "not-file");

    const realRename = fsSync.renameSync.bind(fsSync);
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (to === path.join(root, "failed.txt")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return realRename(from, to);
    });
    expect(() => store.writeText("failed.txt", "secret")).toThrow("permission denied");
    expect(fsSync.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("uses unbounded sync reads and distinguishes missing from malformed JSON", async () => {
    const root = await tempRoot("fs-safe-sync-store-read-");
    const store = fileStoreSync({ rootDir: root });
    await fs.writeFile(path.join(root, "plain.txt"), "plain");
    await fs.writeFile(path.join(root, "bad.json"), "{");

    expect(store.readTextIfExists("plain.txt")).toBe("plain");
    expect(store.readJsonIfExists("missing.json")).toBeNull();
    expect(() => store.readJsonIfExists("bad.json")).toThrow(SyntaxError);
  });
});
