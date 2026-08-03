import { appendFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  categorizeFsSafeError,
  configureFsSafeNative,
  FsSafeError,
  root as openRoot,
} from "../src/index.js";
import { openLocalFileSafely, readLocalFileSafely } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { expectedFsSafeCode, expectFsSafeError } from "./helpers/security.js";

const skipOnWindows = process.platform === "win32";

const { tempDirs, tempRoot } = useTempDirs();


afterEach(async () => {
  configureFsSafeNative({ mode: "auto" });
  __setFsSafeTestHooksForTest(undefined);
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("@openclaw/fs-safe", () => {
  it("classifies routine removal outcomes as operational", () => {
    for (const code of ["not-found", "not-empty", "not-removable"] as const) {
      expect(categorizeFsSafeError(code)).toBe("operational");
      expect(new FsSafeError(code, "remove failed")).toMatchObject({
        category: "operational",
        code,
      });
    }

    for (const code of ["path-alias", "path-mismatch"] as const) {
      expect(categorizeFsSafeError(code)).toBe("policy");
    }
  });

  it.skipIf(skipOnWindows)("reuses a root capability across filesystem operations", async () => {
    const rootPath = await tempRoot("fs-root-object-");
    const root = await openRoot(rootPath);

    await root.mkdir("nested");
    await root.write("nested/file.txt", "hello");
    await root.append("nested/file.txt", " world");

    await expect(root.readText("nested/file.txt")).resolves.toBe("hello world");
    await expect(root.readBytes("nested/file.txt")).resolves.toEqual(
      Buffer.from("hello world"),
    );

    const stat = await root.stat("nested/file.txt");
    expect(stat.isFile).toBe(true);

    await expect(root.list("nested")).resolves.toEqual(["file.txt"]);
    await root.move("nested/file.txt", "nested/renamed.txt");
    await expect(root.read("nested/renamed.txt")).resolves.toMatchObject({
      realPath: expect.stringContaining("renamed.txt"),
    });

    await root.remove("nested/renamed.txt");
    await expectFsSafeError(root.stat("nested/renamed.txt"), "not-found");
  });

  it("rejects non-directory roots before creating a capability", async () => {
    const rootPath = await tempRoot("fs-safe-root-file-");
    const filePath = path.join(rootPath, "file.txt");
    await writeFile(filePath, "not a directory");

    await expect(openRoot(filePath)).rejects.toMatchObject({
      code: "invalid-path",
      message: "root dir is not a directory",
    });
  });

  it.skipIf(skipOnWindows)("can disable the native helper while writes use guarded fallbacks", async () => {
    configureFsSafeNative({ mode: "off" });
    const rootPath = await tempRoot("fs-safe-native-off-");
    const sourceRoot = await tempRoot("fs-safe-native-off-source-");
    const sourcePath = path.join(sourceRoot, "source.txt");
    const root = await openRoot(rootPath);
    await writeFile(sourcePath, "copied");

    await root.mkdir("nested");
    await expect(root.write("nested/file.txt", "hello")).resolves.toBeUndefined();
    await root.copyIn("nested/copied.txt", sourcePath, { maxBytes: 16 });
    await expect(root.stat("nested/file.txt")).resolves.toMatchObject({ isFile: true });
    await expect(root.list("nested")).resolves.toEqual(["copied.txt", "file.txt"]);
    await root.move("nested/file.txt", "nested/moved.txt");
    await expect(root.readText("nested/moved.txt")).resolves.toBe("hello");
    await root.remove("nested/copied.txt");
    await expect(root.exists("nested/copied.txt")).resolves.toBe(false);
  });

  it.skipIf(skipOnWindows)("preserves concurrent append writes", async () => {
    const rootPath = await tempRoot("fs-safe-append-concurrent-");
    const root = await openRoot(rootPath);

    await root.write("logs/today.log", "start");
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        root.append("logs/today.log", `line ${index}`, { prependNewlineIfNeeded: true })
      ),
    );

    const lines = (await root.readText("logs/today.log")).split("\n");
    expect(lines[0]).toBe("start");
    expect(new Set(lines.slice(1))).toEqual(
      new Set(Array.from({ length: 25 }, (_, index) => `line ${index}`)),
    );
    expect(lines).toHaveLength(26);
  });

  it.skipIf(skipOnWindows)("preserves append mkdir and encoding semantics", async () => {
    const rootPath = await tempRoot("fs-safe-append-semantics-");
    const root = await openRoot(rootPath);

    await expectFsSafeError(root.append("missing/file.txt", "x", { mkdir: false }), "not-found");
    await expect(root.exists("missing")).resolves.toBe(false);

    await root.write("utf16.txt", "alpha", { encoding: "utf16le" });
    await root.append("utf16.txt", "beta", {
      encoding: "utf16le",
      prependNewlineIfNeeded: true,
    });
    await expect(root.readBytes("utf16.txt")).resolves.toEqual(
      Buffer.from("alpha\nbeta", "utf16le"),
    );
  });

  it.skipIf(skipOnWindows)("preserves existing file mode during append", async () => {
    const rootPath = await tempRoot("fs-safe-append-mode-");
    const filePath = path.join(rootPath, "secret.txt");
    await writeFile(filePath, "alpha", { mode: 0o600 });
    await chmod(filePath, 0o600);

    const root = await openRoot(rootPath, { mode: 0o644 });
    await root.append("secret.txt", "beta");

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("applies per-root defaults", async () => {
    const rootPath = await tempRoot("fs-safe-defaults-");
    const root = await openRoot(rootPath, {
      hardlinks: "reject",
      mkdir: true,
    });

    await root.writeJson("nested/config.json", { ok: true }, { space: 2 });

    await expect(root.readJson("nested/config.json")).resolves.toEqual({ ok: true });
    await expect(readFile(path.join(rootPath, "nested/config.json"), "utf8")).resolves.toBe(
      '{\n  "ok": true\n}\n',
    );
  });

  it("limits root reads by default and allows explicit larger reads", async () => {
    const rootPath = await tempRoot("fs-safe-default-max-");
    const root = await openRoot(rootPath);
    await writeFile(path.join(rootPath, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));

    await expect(root.read("large.bin")).rejects.toMatchObject({ code: "too-large" });
    await expect(root.readBytes("large.bin", { maxBytes: Number.POSITIVE_INFINITY })).resolves
      .toHaveLength(16 * 1024 * 1024 + 1);
  });

  it("creates files only when missing", async () => {
    const rootPath = await tempRoot("fs-safe-if-missing-");
    const root = await openRoot(rootPath);

    await expect(root.create("nested/file.txt", "first")).resolves.toBeUndefined();
    await expectFsSafeError(root.create("nested/file.txt", "second"), "already-exists");
    await expect(readFile(path.join(rootPath, "nested/file.txt"), "utf8")).resolves.toBe("first");

    await expect(root.createJson("state.json", { ok: true })).resolves.toBeUndefined();
    await expectFsSafeError(root.createJson("state.json", { ok: false }), "already-exists");
    await expect(readFile(path.join(rootPath, "state.json"), "utf8")).resolves.toBe(
      '{"ok":true}\n',
    );
  });

  it.skipIf(skipOnWindows)("writes, reads, stats, and lists files within a root", async () => {
    const root = await openRoot(await tempRoot("fs-safe-basic-"));

    await root.mkdir("nested");
    await root.write("nested/file.txt", "hello");

    const read = await root.read("nested/file.txt");
    expect(read.buffer.toString("utf8")).toBe("hello");

    const stat = await root.stat("nested/file.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(5);
    await expect(root.exists("nested/file.txt")).resolves.toBe(true);
    await expect(root.exists("nested/missing.txt")).resolves.toBe(false);

    await expect(root.list("nested")).resolves.toEqual(["file.txt"]);
    const entries = await root.list("nested", { withFileTypes: true });
    expect(entries).toMatchObject([{ isFile: true, name: "file.txt" }]);
  });

  it("rejects traversal and absolute paths before touching the filesystem", async () => {
    const root = await openRoot(await tempRoot("fs-safe-traversal-"));

    await expect(root.stat("../outside")).rejects.toMatchObject({ code: "invalid-path" });
    await expect(root.read("/etc/passwd")).rejects.toMatchObject({
      category: "policy",
      code: "outside-workspace",
    } satisfies Partial<FsSafeError>);
    await expectFsSafeError(root.write("../write", ""), "outside-workspace");
  });

  it("rejects NUL bytes with FsSafeError before reaching Node fs", async () => {
    const root = await openRoot(await tempRoot("fs-safe-nul-"));

    for (const operation of [
      () => root.resolve("x\0y"),
      () => root.open("x\0y"),
      () => root.openWritable("x\0y"),
      () => root.read("x\0y"),
      () => root.readBytes("x\0y"),
      () => root.readText("x\0y"),
      () => root.readJson("x\0y"),
      () => root.write("x\0y", "data"),
      () => root.append("x\0y", "data"),
      () => root.copyIn("x\0y", path.join(root.rootDir, "source.txt")),
      () => root.exists("x\0y"),
      () => root.stat("x\0y"),
      () => root.list("x\0y"),
      () => root.move("x\0y", "dest.txt"),
      () => root.move("source.txt", "x\0y"),
      () => root.remove("x\0y"),
      () => root.mkdir("x\0y"),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: "invalid-path",
        message: "relative path contains a NUL byte",
      });
    }

    await expect(root.copyIn("dest.txt", `${root.rootDir}/source\0.txt`)).rejects.toMatchObject({
      code: "invalid-path",
      message: "source path contains a NUL byte",
    });
  });

  it("rejects NUL bytes on public root and local-file entry points", async () => {
    const rootPath = await tempRoot("fs-safe-public-nul-");
    const filePath = path.join(rootPath, "file.txt");
    await writeFile(filePath, "ok");

    for (const operation of [
      () => openRoot(`${rootPath}\0bad`),
      () => openLocalFileSafely({ filePath: `${filePath}\0bad` }),
      () => readLocalFileSafely({ filePath: `${filePath}\0bad` }),
    ]) {
      let thrown: unknown;
      try {
        await operation();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "invalid-path" });
      expect(String(thrown)).not.toContain(rootPath);
    }
  });

  it("rejects reader callbacks for absolute paths outside the root", async () => {
    const root = await openRoot(await tempRoot("fs-safe-reader-root-"));
    const outside = await tempRoot("fs-safe-reader-outside-");
    const outsidePath = path.join(outside, "secret.txt");
    await writeFile(outsidePath, "secret");

    await expectFsSafeError(root.reader()(outsidePath), "outside-workspace");
  });

  it("rejects symlink parents", async () => {
    const rootPath = await tempRoot("fs-safe-symlink-parent-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(rootPath, "link"), "dir");

    await expectFsSafeError(root.read("link/secret.txt"), "outside-workspace");
    await expect(root.list("link")).rejects.toMatchObject({ code: expectedFsSafeCode("path-alias") });
  });

  it("rejects symlink leaves for stat and read", async () => {
    const rootPath = await tempRoot("fs-safe-symlink-leaf-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(rootPath, "secret-link"), "file");

    await expect(root.stat("secret-link")).rejects.toMatchObject({ code: expectedFsSafeCode("path-alias") });
    await expect(root.read("secret-link")).rejects.toMatchObject({ code: "symlink" });
  });

  it.skipIf(skipOnWindows)("renames paths within the same root and rejects symlink sources", async () => {
    const rootPath = await tempRoot("fs-safe-rename-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await root.write("from.txt", "move me");

    await root.move("from.txt", "to.txt");
    await expect(readFile(path.join(rootPath, "to.txt"), "utf8")).resolves.toBe("move me");

    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(rootPath, "link"), "file");
    await expectFsSafeError(root.move("link", "moved-link"), "path-alias");
  });

  it.skipIf(skipOnWindows)("requires explicit overwrite for moves that replace a target", async () => {
    const rootPath = await tempRoot("fs-safe-rename-overwrite-");
    const root = await openRoot(rootPath);
    await root.write("from.txt", "source");
    await root.write("to.txt", "target");

    await expectFsSafeError(root.move("from.txt", "to.txt"), "already-exists");
    await expect(readFile(path.join(rootPath, "to.txt"), "utf8")).resolves.toBe("target");

    await root.move("from.txt", "to.txt", { overwrite: true });
    await expect(readFile(path.join(rootPath, "to.txt"), "utf8")).resolves.toBe("source");
  });

  it.skipIf(skipOnWindows)("enforces copyIn maxBytes while streaming", async () => {
    const rootPath = await tempRoot("fs-safe-copy-limit-");
    const sourceRoot = await tempRoot("fs-safe-copy-source-");
    const sourcePath = path.join(sourceRoot, "source.txt");
    await writeFile(sourcePath, "1234");
    const root = await openRoot(rootPath);

    __setFsSafeTestHooksForTest({
      afterOpen(filePath, handle) {
        if (filePath !== sourcePath) {
          return;
        }
        appendFileSync(sourcePath, "567890");
      },
    });

    await expectFsSafeError(root.copyIn("copied.txt", sourcePath, { maxBytes: 4 }), "too-large");
    await expect(root.exists("copied.txt")).resolves.toBe(false);
    await expect(readdir(rootPath)).resolves.toEqual([]);
  });

  itPosix("rejects a copy when the source path is swapped after open", async () => {
    const rootPath = await tempRoot("fs-safe-copy-source-swap-root-");
    const sourceRoot = await tempRoot("fs-safe-copy-source-swap-source-");
    const sourcePath = path.join(sourceRoot, "source.txt");
    const replacementPath = path.join(sourceRoot, "replacement.txt");
    await writeFile(sourcePath, "original");
    await writeFile(replacementPath, "replacement");
    let swapped = false;
    __setFsSafeTestHooksForTest({
      afterOpen: async (openedPath) => {
        if (!swapped && openedPath === sourcePath) {
          swapped = true;
          await rm(sourcePath);
          await rename(replacementPath, sourcePath);
        }
      },
    });
    const scoped = await openRoot(rootPath);
    await expectFsSafeError(scoped.copyIn("copied.txt", sourcePath, { maxBytes: 1024 }), "path-mismatch");
    await expect(stat(path.join(rootPath, "copied.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes symlink leaves without following them", async () => {
    const rootPath = await tempRoot("fs-safe-remove-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    const outsideFile = path.join(outside, "kept.txt");
    await writeFile(outsideFile, "kept");
    await symlink(outsideFile, path.join(rootPath, "link"), "file");

    await root.remove("link");

    await expect(readFile(outsideFile, "utf8")).resolves.toBe("kept");
    await expect(root.stat("link")).rejects.toMatchObject({
      code: expectedFsSafeCode("not-found"),
    });
  });

  it("reports documented failure codes when remove cannot unlink the target", async () => {
    const rootPath = await tempRoot("fs-safe-remove-codes-");
    const root = await openRoot(rootPath);
    await root.mkdir("full/child");

    await expect(root.remove("missing.txt")).rejects.toMatchObject({
      code: expectedFsSafeCode("not-found"),
    });
    await expect(root.remove("missing-dir/missing.txt")).rejects.toMatchObject({
      code: expectedFsSafeCode("not-found"),
    });
    await expect(root.remove("full")).rejects.toMatchObject({
      code: expectedFsSafeCode("not-empty"),
    });
  });

  it("opens a file handle for fast reads when kernel fd path validation is available", async () => {
    const root = await openRoot(await tempRoot("fs-safe-open-"));
    await root.write("file.txt", "fast");

    const opened = await root.open("file.txt");
    try {
      await expect(opened.handle.readFile("utf8")).resolves.toBe("fast");
    } finally {
      await opened.handle.close();
    }
  });

  it("supports await using for escaped read and write handles", async () => {
    const rootPath = await tempRoot("fs-safe-dispose-");
    const root = await openRoot(rootPath);
    await root.write("file.txt", "fast");

    {
      await using opened = await root.open("file.txt");
      await expect(opened.handle.readFile("utf8")).resolves.toBe("fast");
    }

    {
      await using writable = await root.openWritable("write.txt");
      await writable.handle.writeFile("written");
    }

    await expect(readFile(path.join(rootPath, "write.txt"), "utf8")).resolves.toBe("written");

    {
      await using writable = await root.openWritable("write.txt", { writeMode: "append" });
      await writable.handle.appendFile(" again");
    }

    await expect(readFile(path.join(rootPath, "write.txt"), "utf8")).resolves.toBe(
      "written again",
    );
  });

  itPosix("honors mode on root text and JSON writes", async () => {
    const rootPath = await tempRoot("fs-safe-write-mode-");
    const root = await openRoot(rootPath);

    await root.write("secret.txt", "secret", { mode: 0o640 });
    await root.writeJson("secret.json", { ok: true }, { mode: 0o640 });

    await expect(stat(path.join(rootPath, "secret.txt")).then((s) => s.mode & 0o777)).resolves
      .toBe(0o640);
    await expect(stat(path.join(rootPath, "secret.json")).then((s) => s.mode & 0o777)).resolves
      .toBe(0o640);
  });

  itPosix("honors default mode on root writes", async () => {
    const rootPath = await tempRoot("fs-safe-default-write-mode-");
    const root = await openRoot(rootPath, { mode: 0o640 });

    await root.write("secret.txt", "secret");
    await root.writeJson("secret.json", { ok: true });

    await expect(stat(path.join(rootPath, "secret.txt")).then((s) => s.mode & 0o777)).resolves
      .toBe(0o640);
    await expect(stat(path.join(rootPath, "secret.json")).then((s) => s.mode & 0o777)).resolves
      .toBe(0o640);
  });
});
