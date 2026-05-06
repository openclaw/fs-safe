import { appendFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafePython, FsSafeError, root as openRoot } from "../src/index.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  configureFsSafePython({ mode: "auto", pythonPath: undefined });
  __setFsSafeTestHooksForTest(undefined);
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("@openclaw/fs-safe", () => {
  it("reuses a root capability across filesystem operations", async () => {
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
    await expect(root.stat("nested/renamed.txt")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("can disable the Python helper and keep root operations available", async () => {
    configureFsSafePython({ mode: "off" });
    const rootPath = await tempRoot("fs-safe-python-off-");
    const sourceRoot = await tempRoot("fs-safe-python-off-source-");
    const sourcePath = path.join(sourceRoot, "source.txt");
    const root = await openRoot(rootPath);
    await writeFile(sourcePath, "copied");

    await root.mkdir("nested");
    await root.write("nested/file.txt", "hello");
    await root.copyIn("nested/copied.txt", sourcePath, { maxBytes: 16 });
    await expect(root.stat("nested/file.txt")).resolves.toMatchObject({ isFile: true });
    await expect(root.list("nested")).resolves.toEqual(["copied.txt", "file.txt"]);
    await root.move("nested/file.txt", "nested/moved.txt");
    await expect(root.readText("nested/moved.txt")).resolves.toBe("hello");
    await root.remove("nested/copied.txt");
    await expect(root.exists("nested/copied.txt")).resolves.toBe(false);
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
    await expect(root.create("nested/file.txt", "second")).rejects.toMatchObject({
      code: "already-exists",
    });
    await expect(readFile(path.join(rootPath, "nested/file.txt"), "utf8")).resolves.toBe("first");

    await expect(root.createJson("state.json", { ok: true })).resolves.toBeUndefined();
    await expect(root.createJson("state.json", { ok: false })).rejects.toMatchObject({
      code: "already-exists",
    });
    await expect(readFile(path.join(rootPath, "state.json"), "utf8")).resolves.toBe(
      '{"ok":true}\n',
    );
  });

  it("writes, reads, stats, and lists files within a root", async () => {
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
    await expect(root.write("../write", "")).rejects.toMatchObject({
      code: "outside-workspace",
    });
  });

  it("rejects reader callbacks for absolute paths outside the root", async () => {
    const root = await openRoot(await tempRoot("fs-safe-reader-root-"));
    const outside = await tempRoot("fs-safe-reader-outside-");
    const outsidePath = path.join(outside, "secret.txt");
    await writeFile(outsidePath, "secret");

    await expect(root.reader()(outsidePath)).rejects.toMatchObject({
      code: "outside-workspace",
    });
  });

  it("rejects symlink parents", async () => {
    const rootPath = await tempRoot("fs-safe-symlink-parent-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(rootPath, "link"), "dir");

    await expect(root.read("link/secret.txt")).rejects.toMatchObject({
      code: "outside-workspace",
    });
    await expect(root.list("link")).rejects.toMatchObject({ code: "path-alias" });
  });

  it("rejects symlink leaves for stat and read", async () => {
    const rootPath = await tempRoot("fs-safe-symlink-leaf-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(rootPath, "secret-link"), "file");

    await expect(root.stat("secret-link")).rejects.toMatchObject({ code: "path-alias" });
    await expect(root.read("secret-link")).rejects.toMatchObject({ code: "symlink" });
  });

  it("renames paths within the same root and rejects symlink sources", async () => {
    const rootPath = await tempRoot("fs-safe-rename-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await root.write("from.txt", "move me");

    await root.move("from.txt", "to.txt");
    await expect(readFile(path.join(rootPath, "to.txt"), "utf8")).resolves.toBe("move me");

    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(rootPath, "link"), "file");
    await expect(root.move("link", "moved-link")).rejects.toMatchObject({
      code: "path-alias",
    });
  });

  it("requires explicit overwrite for moves that replace a target", async () => {
    const rootPath = await tempRoot("fs-safe-rename-overwrite-");
    const root = await openRoot(rootPath);
    await root.write("from.txt", "source");
    await root.write("to.txt", "target");

    await expect(root.move("from.txt", "to.txt")).rejects.toMatchObject({
      code: "already-exists",
    });
    await expect(readFile(path.join(rootPath, "to.txt"), "utf8")).resolves.toBe("target");

    await root.move("from.txt", "to.txt", { overwrite: true });
    await expect(readFile(path.join(rootPath, "to.txt"), "utf8")).resolves.toBe("source");
  });

  it("enforces copyIn maxBytes while streaming", async () => {
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

    await expect(root.copyIn("copied.txt", sourcePath, { maxBytes: 4 })).rejects.toMatchObject({
      code: "too-large",
    });
    await expect(root.exists("copied.txt")).resolves.toBe(false);
    await expect(readdir(rootPath)).resolves.toEqual([]);
  });

  it("rejects pinned copy when the source path is swapped after identity capture", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { runPinnedCopyHelper } = await import("../src/pinned-write.js");
    const rootPath = await tempRoot("fs-safe-copy-source-swap-root-");
    const sourceRoot = await tempRoot("fs-safe-copy-source-swap-source-");
    const sourcePath = path.join(sourceRoot, "source.txt");
    const replacementPath = path.join(sourceRoot, "replacement.txt");
    await writeFile(sourcePath, "original");
    await writeFile(replacementPath, "replacement");
    const sourceIdentity = await stat(sourcePath);
    await rm(sourcePath);
    await rename(replacementPath, sourcePath);

    configureFsSafePython({ mode: "require" });
    try {
      await runPinnedCopyHelper({
        rootPath,
        relativeParentPath: "",
        basename: "copied.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: true,
        maxBytes: 1024,
        sourcePath,
        sourceIdentity: { dev: sourceIdentity.dev, ino: sourceIdentity.ino },
      });
      throw new Error("expected pinned copy source swap to fail");
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "helper-unavailable") {
        return;
      }
      expect(error).toMatchObject({ code: "path-mismatch" });
    }
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
      code: "not-found",
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

  it("honors mode on root text and JSON writes", async () => {
    const rootPath = await tempRoot("fs-safe-write-mode-");
    const root = await openRoot(rootPath);

    await root.write("secret.txt", "secret", { mode: 0o640 });
    await root.writeJson("secret.json", { ok: true }, { mode: 0o640 });

    if (process.platform !== "win32") {
      await expect(stat(path.join(rootPath, "secret.txt")).then((s) => s.mode & 0o777)).resolves
        .toBe(0o640);
      await expect(stat(path.join(rootPath, "secret.json")).then((s) => s.mode & 0o777)).resolves
        .toBe(0o640);
    }
  });

  it("honors default mode on root writes", async () => {
    const rootPath = await tempRoot("fs-safe-default-write-mode-");
    const root = await openRoot(rootPath, { mode: 0o640 });

    await root.write("secret.txt", "secret");
    await root.writeJson("secret.json", { ok: true });

    if (process.platform !== "win32") {
      await expect(stat(path.join(rootPath, "secret.txt")).then((s) => s.mode & 0o777)).resolves
        .toBe(0o640);
      await expect(stat(path.join(rootPath, "secret.json")).then((s) => s.mode & 0o777)).resolves
        .toBe(0o640);
    }
  });
});
