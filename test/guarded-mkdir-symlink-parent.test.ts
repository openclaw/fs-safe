import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { mkdirPathComponentsWithGuards } from "../src/guarded-mkdir.js";

const tempDirs = new Set<string>();

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

it("treats an in-root symlinked directory component as valid instead of rejecting it", async () => {
  const root = await tempRoot("fs-safe-mkdir-symlink-ok-");
  const realDir = path.join(root, "bank", "skills", "auth-doctor");
  await fs.mkdir(realDir, { recursive: true });
  const skillsDir = path.join(root, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(realDir, path.join(skillsDir, "auth-doctor"), "dir");

  const targetPath = path.join(skillsDir, "auth-doctor", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: root, targetPath }),
  ).resolves.toBeUndefined();

  const stat = await fs.lstat(targetPath);
  expect(stat.isDirectory()).toBe(true);
  // The created directory should exist at the real (resolved) location too,
  // since we descend through the symlink's real target.
  const realNested = await fs.lstat(path.join(realDir, "nested"));
  expect(realNested.isDirectory()).toBe(true);
});

it("still rejects a symlinked directory component that escapes the root", async () => {
  const root = await tempRoot("fs-safe-mkdir-symlink-escape-root-");
  const outside = await tempRoot("fs-safe-mkdir-symlink-escape-outside-");
  const skillsDir = path.join(root, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(outside, path.join(skillsDir, "escape"), "dir");

  const targetPath = path.join(skillsDir, "escape", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: root, targetPath }),
  ).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "outside-workspace",
  });
});

it("still rejects a path component that is a plain file", async () => {
  const root = await tempRoot("fs-safe-mkdir-file-component-");
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  await fs.writeFile(path.join(root, "skills", "not-a-dir"), "content", "utf8");

  const targetPath = path.join(root, "skills", "not-a-dir", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: root, targetPath }),
  ).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "not-file",
  });
});

it("still rejects a symlink component that points at a file, not a directory", async () => {
  const root = await tempRoot("fs-safe-mkdir-symlink-to-file-");
  const realFile = path.join(root, "target-file");
  await fs.writeFile(realFile, "content", "utf8");
  const skillsDir = path.join(root, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(realFile, path.join(skillsDir, "bad-link"), "file");

  const targetPath = path.join(skillsDir, "bad-link", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: root, targetPath }),
  ).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "not-file",
  });
});
