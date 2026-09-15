import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { FsSafeError } from "../src/errors.js";
import { mkdirPathComponentsWithGuards } from "../src/guarded-mkdir.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";

const { tempRoot } = useTempDirs();


afterEach(async () => {
  configureFsSafeNative({ mode: "auto" });
});

// --- Unit-level coverage of mkdirPathComponentsWithGuards itself ---

async function ancestorAliasFixture(prefix: string) {
  const container = await tempRoot(prefix);
  const realAncestor = path.join(container, "real-ancestor");
  const aliasAncestor = path.join(container, "ancestor-alias");
  const rootCanonical = path.join(realAncestor, "Root");
  await fs.mkdir(rootCanonical, { recursive: true });
  await fs.symlink(realAncestor, aliasAncestor, process.platform === "win32" ? "junction" : "dir");
  const rootAlias = path.join(aliasAncestor, "Root");
  const identity = await fs.lstat(rootAlias, { bigint: true });
  return {
    aliasAncestor,
    identity: { dev: identity.dev, ino: identity.ino },
    realAncestor,
    rootAlias,
    rootCanonical: await fs.realpath(rootCanonical),
  };
}

it("rebases original and canonical target spellings through an ancestor alias", async () => {
  const fixture = await ancestorAliasFixture("fs-safe-mkdir-ancestor-alias-");
  const originalTarget = path.join(fixture.rootAlias, "from-alias", "nested");
  const canonicalTarget = path.join(fixture.rootCanonical, "from-canonical", "nested");

  await expect(mkdirPathComponentsWithGuards({
    rootReal: fixture.rootAlias,
    rootIdentity: fixture.identity,
    targetPath: originalTarget,
  })).resolves.toBe(path.join(fixture.rootCanonical, "from-alias", "nested"));
  await expect(mkdirPathComponentsWithGuards({
    rootReal: fixture.rootAlias,
    rootIdentity: fixture.identity,
    targetPath: canonicalTarget,
  })).resolves.toBe(canonicalTarget);

  expect((await fs.lstat(path.join(fixture.rootCanonical, "from-alias", "nested"))).isDirectory()).toBe(true);
  expect((await fs.lstat(canonicalTarget)).isDirectory()).toBe(true);
});

it("rejects a mismatched supplied alias-root identity before mutation", async () => {
  const fixture = await ancestorAliasFixture("fs-safe-mkdir-alias-identity-");
  const targetPath = path.join(fixture.rootAlias, "must-not-exist");
  const mutations: string[] = [];

  await expect(mkdirPathComponentsWithGuards({
    rootReal: fixture.rootAlias,
    rootIdentity: { dev: fixture.identity.dev, ino: fixture.identity.ino + 1n },
    targetPath,
    beforeComponent: (componentPath) => { mutations.push(componentPath); },
  })).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "path-mismatch",
  });
  expect(mutations).toEqual([]);
  await expect(fs.lstat(path.join(fixture.rootCanonical, "must-not-exist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects a case-distinct sibling under an ancestor alias where supported", async (context) => {
  const container = await tempRoot("fs-safe-mkdir-alias-case-");
  const realAncestor = path.join(container, "real-ancestor");
  await fs.mkdir(realAncestor);
  if (process.platform === "win32") {
    const enabled = spawnSync(
      resolveWindowsSystemCommand("fsutil.exe"),
      ["file", "setCaseSensitiveInfo", realAncestor, "enable"],
      { stdio: "ignore", timeout: 10_000, windowsHide: true },
    );
    if (enabled.error || enabled.status !== 0) {
      context.skip();
      return;
    }
  }

  const trustedRoot = path.join(realAncestor, "Root");
  const foldedSibling = path.join(realAncestor, "root");
  try {
    await fs.mkdir(trustedRoot);
    await fs.mkdir(foldedSibling);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      context.skip();
      return;
    }
    throw error;
  }
  const trustedIdentity = await fs.lstat(trustedRoot, { bigint: true });
  const siblingIdentity = await fs.lstat(foldedSibling, { bigint: true });
  if (trustedIdentity.dev === siblingIdentity.dev && trustedIdentity.ino === siblingIdentity.ino) {
    context.skip();
    return;
  }

  const aliasAncestor = path.join(container, "ancestor-alias");
  await fs.symlink(realAncestor, aliasAncestor, process.platform === "win32" ? "junction" : "dir");
  const rootAlias = path.join(aliasAncestor, "Root");
  const targetPath = path.join(aliasAncestor, "root", "must-not-exist");
  const mutations: string[] = [];

  await expect(mkdirPathComponentsWithGuards({
    rootReal: rootAlias,
    rootIdentity: { dev: trustedIdentity.dev, ino: trustedIdentity.ino },
    targetPath,
    beforeComponent: (componentPath) => { mutations.push(componentPath); },
  })).rejects.toBeInstanceOf(FsSafeError);
  expect(mutations).toEqual([]);
  await expect(fs.lstat(path.join(foldedSibling, "must-not-exist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("treats an in-root symlinked directory component as valid instead of rejecting it", async () => {
  const rootDir = await tempRoot("fs-safe-mkdir-symlink-ok-");
  const realDir = path.join(rootDir, "bank", "skills", "auth-doctor");
  await fs.mkdir(realDir, { recursive: true });
  const skillsDir = path.join(rootDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(realDir, path.join(skillsDir, "auth-doctor"), "dir");

  const targetPath = path.join(skillsDir, "auth-doctor", "nested");
  const resolved = await mkdirPathComponentsWithGuards({ rootReal: rootDir, targetPath });

  // The returned path must be the *real* resolved directory, not the
  // lexical (symlinked) one, so callers can safely re-guard it.
  expect(resolved).toBe(path.join(await fs.realpath(realDir), "nested"));

  const stat = await fs.lstat(targetPath);
  expect(stat.isDirectory()).toBe(true);
  const realNested = await fs.lstat(path.join(realDir, "nested"));
  expect(realNested.isDirectory()).toBe(true);
});

it("still rejects a symlinked directory component that escapes the root", async () => {
  const rootDir = await tempRoot("fs-safe-mkdir-symlink-escape-root-");
  const outside = await tempRoot("fs-safe-mkdir-symlink-escape-outside-");
  const skillsDir = path.join(rootDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(outside, path.join(skillsDir, "escape"), "dir");

  const targetPath = path.join(skillsDir, "escape", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: rootDir, targetPath }),
  ).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "outside-workspace",
  });
});

it("still rejects a path component that is a plain file", async () => {
  const rootDir = await tempRoot("fs-safe-mkdir-file-component-");
  await fs.mkdir(path.join(rootDir, "skills"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "skills", "not-a-dir"), "content", "utf8");

  const targetPath = path.join(rootDir, "skills", "not-a-dir", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: rootDir, targetPath }),
  ).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "not-file",
  });
});

it("still rejects a symlink component that points at a file, not a directory", async () => {
  const rootDir = await tempRoot("fs-safe-mkdir-symlink-to-file-");
  const realFile = path.join(rootDir, "target-file");
  await fs.writeFile(realFile, "content", "utf8");
  const skillsDir = path.join(rootDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(realFile, path.join(skillsDir, "bad-link"), "file");

  const targetPath = path.join(skillsDir, "bad-link", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: rootDir, targetPath }),
  ).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "not-file",
  });
});

it("rejects a dangling symlink directory component with a typed FsSafeError, not a raw ENOENT", async () => {
  const rootDir = await tempRoot("fs-safe-mkdir-dangling-symlink-");
  const skillsDir = path.join(rootDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(path.join(rootDir, "does-not-exist"), path.join(skillsDir, "dangling"), "dir");

  const targetPath = path.join(skillsDir, "dangling", "nested");
  await expect(
    mkdirPathComponentsWithGuards({ rootReal: rootDir, targetPath }),
  ).rejects.toMatchObject({
    constructor: FsSafeError,
    code: "not-file",
  });
});

// --- End-to-end coverage through root().write(), the actual code path a
// real caller (e.g. OpenClaw's skill-workshop apply) exercises. The unit
// tests above alone do not cover this: root().write()'s JS fallback path
// re-derives its own parent-directory guard after
// mkdirPathComponentsWithGuards returns, so the fix must flow the resolved
// path back to the caller, not just resolve it internally. ---

itPosix("writes a file through root().write() when the parent directory is an in-root symlink (mkdir: true)", async () => {
// Force the JS fallback path deterministically, matching this repo's own
// convention in test/pinned-write-fallback-coverage.test.ts.
configureFsSafeNative({ mode: "off" });

const rootDir = await tempRoot("fs-safe-root-write-symlink-");
const realDir = path.join(rootDir, "skills-bank", "skills", "auth-doctor");
await fs.mkdir(realDir, { recursive: true });
await fs.writeFile(path.join(realDir, "SKILL.md"), "# old content\n", "utf8");
const skillsDir = path.join(rootDir, "skills");
await fs.mkdir(skillsDir, { recursive: true });
await fs.symlink(realDir, path.join(skillsDir, "auth-doctor"), "dir");

const r = await root(rootDir);
await expect(
  r.write("skills/auth-doctor/SKILL.md", "# new content\n", {
    encoding: "utf8",
    mkdir: true,
    overwrite: true,
  }),
).resolves.toBeUndefined();

const written = await fs.readFile(path.join(realDir, "SKILL.md"), "utf8");
expect(written).toBe("# new content\n");
});

itPosix("appends and opens writable files through an in-root symlinked parent", async () => {
  const rootDir = await tempRoot("fs-safe-root-writable-symlink-");
  const realDir = path.join(rootDir, "real-parent");
  await fs.mkdir(realDir);
  await fs.symlink(realDir, path.join(rootDir, "alias"), "dir");
  const r = await root(rootDir);

  await r.append("alias/logs/app.log", "entry\n");
  const opened = await r.openWritable("alias/output/result.txt");
  try {
    await opened.handle.writeFile("result\n");
  } finally {
    await opened.handle.close();
  }

  await expect(fs.readFile(path.join(realDir, "logs/app.log"), "utf8")).resolves.toBe(
    "entry\n",
  );
  await expect(fs.readFile(path.join(realDir, "output/result.txt"), "utf8")).resolves.toBe(
    "result\n",
  );
});
