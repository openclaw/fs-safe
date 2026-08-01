import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root as openRoot } from "../src/index.js";

const skipOnWindows = process.platform === "win32";
const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("root denyMutations policies", () => {
  it("denies root mutations by exact denied path", async () => {
    const rootPath = await tempRoot("fs-safe-deny-exact-");
    const sourceRoot = await tempRoot("fs-safe-deny-exact-source-");
    const sourcePath = path.join(sourceRoot, "source.txt");
    const deniedPath = path.join(rootPath, "secret.txt");
    const root = await openRoot(rootPath, {
      mkdir: true,
      denyMutations: { paths: [deniedPath] },
    });
    await writeFile(sourcePath, "source");

    for (const operation of [
      () => root.write("secret.txt", "write"),
      () => root.append("secret.txt", "append"),
      () => root.create("secret.txt", "create"),
      () => root.openWritable("secret.txt"),
      () => root.copyIn("secret.txt", sourcePath),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "denied-path" });
    }

    await expect(root.exists("secret.txt")).resolves.toBe(false);
  });

  it("denies root mutations by denied prefix", async () => {
    const rootPath = await tempRoot("fs-safe-deny-prefix-");
    const deniedDir = path.join(rootPath, "private");
    await mkdir(deniedDir, { recursive: true });
    await writeFile(path.join(deniedDir, "seed.txt"), "seed");
    await writeFile(path.join(deniedDir, "source.txt"), "source");
    await writeFile(path.join(rootPath, "safe.txt"), "safe");
    const root = await openRoot(rootPath, {
      denyMutations: { prefixes: [deniedDir] },
    });

    await expect(root.write("private/file.txt", "write")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.mkdir("private/nested")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.remove("private/seed.txt")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.move("safe.txt", "private/moved.txt")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.move("private/source.txt", "moved-out.txt")).rejects.toMatchObject({
      code: "denied-path",
    });

    await expect(readFile(path.join(rootPath, "safe.txt"), "utf8")).resolves.toBe("safe");
    await expect(readFile(path.join(deniedDir, "seed.txt"), "utf8")).resolves.toBe("seed");
    await expect(readFile(path.join(deniedDir, "source.txt"), "utf8")).resolves.toBe("source");
  });

  it("merges root and per-call denyMutations without weakening defaults", async () => {
    const rootPath = await tempRoot("fs-safe-deny-merge-");
    const rootDeniedPath = path.join(rootPath, "root-denied.txt");
    const callDeniedPath = path.join(rootPath, "call-denied.txt");
    const root = await openRoot(rootPath, {
      denyMutations: { paths: [rootDeniedPath] },
    });

    await expect(
      root.write("root-denied.txt", "write", { denyMutations: { paths: [] } }),
    ).rejects.toMatchObject({ code: "denied-path" });
    await expect(
      root.write("call-denied.txt", "write", {
        denyMutations: { paths: [callDeniedPath] },
      }),
    ).rejects.toMatchObject({ code: "denied-path" });
    await expect(
      root.ensureRoot({ denyMutations: { paths: [rootPath] } }),
    ).rejects.toMatchObject({ code: "denied-path" });

    await expect(
      root.write("allowed.txt", "ok", { denyMutations: { paths: [callDeniedPath] } }),
    ).resolves.toBeUndefined();
    await expect(root.readText("allowed.txt")).resolves.toBe("ok");
  });

  it("rejects relative denyMutations entries", async () => {
    const root = await openRoot(await tempRoot("fs-safe-deny-relative-"));

    await expect(
      root.write("file.txt", "write", { denyMutations: { paths: ["file.txt"] } }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("rejects empty denyMutations entries", async () => {
    const root = await openRoot(await tempRoot("fs-safe-deny-empty-"));

    await expect(
      root.write("file.txt", "write", { denyMutations: { paths: [""] } }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("preserves trailing whitespace in denied paths", async () => {
    const rootPath = await tempRoot("fs-safe-deny-space-");
    const deniedName = "secret ";
    const trimmedName = "secret";
    const root = await openRoot(rootPath, {
      denyMutations: { paths: [path.join(rootPath, deniedName)] },
    });

    await expect(root.write(deniedName, "blocked")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.write(trimmedName, "allowed")).resolves.toBeUndefined();
    await expect(readFile(path.join(rootPath, trimmedName), "utf8")).resolves.toBe("allowed");
  });

  it("preserves trailing whitespace in denied prefixes", async () => {
    const rootPath = await tempRoot("fs-safe-deny-prefix-space-");
    const deniedDir = path.join(rootPath, "private ");
    const trimmedDir = path.join(rootPath, "private");
    await mkdir(deniedDir, { recursive: true });
    await mkdir(trimmedDir, { recursive: true });
    const root = await openRoot(rootPath, {
      denyMutations: { prefixes: [deniedDir] },
    });

    await expect(root.write("private /file.txt", "blocked")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.write("private/file.txt", "allowed")).resolves.toBeUndefined();
    await expect(readFile(path.join(trimmedDir, "file.txt"), "utf8")).resolves.toBe("allowed");
  });

  it("denies removing an ancestor of a denied path", async () => {
    const rootPath = await tempRoot("fs-safe-deny-remove-ancestor-");
    await mkdir(path.join(rootPath, "parent", "locked"), { recursive: true });
    await writeFile(path.join(rootPath, "parent", "locked", "secret.txt"), "secret");
    const root = await openRoot(rootPath, {
      denyMutations: { paths: [path.join(rootPath, "parent", "locked", "secret.txt")] },
    });

    await expect(root.remove("parent")).rejects.toMatchObject({ code: "denied-path" });
    await expect(readFile(path.join(rootPath, "parent", "locked", "secret.txt"), "utf8")).resolves.toBe(
      "secret",
    );
  });

  it("denies moving an ancestor of a denied prefix", async () => {
    const rootPath = await tempRoot("fs-safe-deny-move-ancestor-");
    await mkdir(path.join(rootPath, "parent", "locked"), { recursive: true });
    await writeFile(path.join(rootPath, "parent", "locked", "secret.txt"), "secret");
    const root = await openRoot(rootPath, {
      denyMutations: { prefixes: [path.join(rootPath, "parent", "locked")] },
    });

    await expect(root.move("parent", "moved", { overwrite: true })).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(readFile(path.join(rootPath, "parent", "locked", "secret.txt"), "utf8")).resolves.toBe(
      "secret",
    );
  });

  it("allows creating an ancestor directory for a denied future path", async () => {
    const rootPath = await tempRoot("fs-safe-deny-mkdir-ancestor-");
    const root = await openRoot(rootPath, {
      denyMutations: { paths: [path.join(rootPath, "parent", "secret.txt")] },
    });

    await expect(root.mkdir("parent")).resolves.toBeUndefined();
    await expect(root.write("parent/secret.txt", "blocked")).rejects.toMatchObject({
      code: "denied-path",
    });
  });

  it.skipIf(skipOnWindows)("matches denyMutations through existing symlink ancestors", async () => {
    const rootPath = await tempRoot("fs-safe-deny-symlink-");
    const deniedDir = path.join(rootPath, "private");
    await mkdir(deniedDir, { recursive: true });
    await symlink(deniedDir, path.join(rootPath, "link"), "dir");
    const root = await openRoot(rootPath, {
      denyMutations: { prefixes: [deniedDir] },
    });

    await expect(root.write("link/file.txt", "write")).rejects.toMatchObject({
      code: "denied-path",
    });
  });
});
