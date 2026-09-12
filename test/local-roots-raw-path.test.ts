import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { resolveRootPath, resolveRootPathSync } from "../src/root-path.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.unstubAllEnvs());

it("accepts missing canonical descendants of a configured filesystem-root alias", async () => {
  const dir = await tempRoot("fs-safe-local-root-alias-");
  const filesystemRoot = path.parse(dir).root;
  const alias = path.join(dir, "alias");
  await fs.symlink(filesystemRoot, alias, process.platform === "win32" ? "junction" : "dir");
  const filePath = path.join(filesystemRoot, `missing-${path.basename(dir)}`);
  await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [alias], allowMissing: true }))
    .toEqual({ path: filePath, root: filesystemRoot });
  const params = { rootPath: alias, absolutePath: filePath, boundaryLabel: "fixture" };
  expect(resolveRootPathSync(params)).toMatchObject({ canonicalPath: filePath, exists: false });
  await expect(resolveRootPath(params)).resolves.toMatchObject({ canonicalPath: filePath, exists: false });
});

async function fixture() {
  const dir = await tempRoot("fs-safe-local-roots-raw-");
  await fs.mkdir(path.join(dir, "deep", "dir"), { recursive: true });
  await fs.writeFile(path.join(dir, "value"), "lexical bytes");
  await fs.writeFile(path.join(dir, "deep", "value"), "canonical bytes");
  await fs.symlink(path.join(dir, "deep", "dir"), path.join(dir, "link"),
    process.platform === "win32" ? "junction" : "dir");
  return dir;
}

it.each(["absolute", "home"])("preserves %s raw path traversal in sync local-root resolution", async spelling => {
  const dir = await fixture();
  vi.stubEnv("OPENCLAW_HOME", dir);
  const filePath = `${spelling === "home" ? "~" : dir}${path.sep}link${path.sep}..${path.sep}value`;
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true }))
    .toEqual({ path: path.join(dir, "deep", "value"), root: dir });
});

it.each(["absolute", "home"])("preserves %s traversal and rejection policy in local-root reads", async spelling => {
  const dir = await fixture();
  vi.stubEnv("OPENCLAW_HOME", dir);
  const filePath = `${spelling === "home" ? "~" : dir}${path.sep}link${path.sep}..${path.sep}value`;
  const result = await readLocalFileFromRoots({ filePath, roots: [dir], symlinks: "follow-within-root" });
  expect(result?.buffer.toString("utf8")).toBe("canonical bytes");
  expect(await readLocalFileFromRoots({ filePath, roots: [dir] })).toBeNull();
});

it.skipIf(process.platform === "win32")("keeps requireFile rejection of a final symlink", async () => {
  const dir = await fixture();
  const filePath = path.join(dir, "file-link");
  await fs.symlink("deep/value", filePath);
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir] })?.path).toBe(path.join(dir, "deep", "value"));
});

it.skipIf(process.platform === "win32")("keeps requireFile rejection of an external final symlink into the root", async () => {
  const dir = await fixture();
  const outside = await tempRoot("fs-safe-local-external-link-");
  const filePath = path.join(outside, "file-link");
  await fs.symlink(path.join(dir, "deep", "value"), filePath);
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir] })?.path).toBe(path.join(dir, "deep", "value"));
});

it.skipIf(process.platform === "win32")("rejects parent traversal through a symlink to a regular file", async () => {
  const dir = await fixture();
  await fs.symlink("deep/value", path.join(dir, "file-link"));
  await fs.writeFile(path.join(dir, "deep", "secret"), "must not read");
  const filePath = `${dir}/file-link/../secret`;
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
  expect(await readLocalFileFromRoots({ filePath, roots: [dir], symlinks: "follow-within-root" })).toBeNull();
});

it("rejects parent traversal through a regular file component", async () => {
  const dir = await fixture();
  const filePath = `${dir}${path.sep}deep${path.sep}value${path.sep}..${path.sep}value`;
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
  expect(await readLocalFileFromRoots({ filePath, roots: [dir], symlinks: "follow-within-root" })).toBeNull();
});

it.each(["/", "/.", "/./"])("rejects a regular file followed by a directory suffix %s", async suffix => {
  const dir = await fixture();
  const filePath = `${dir}${path.sep}deep${path.sep}value${suffix}`;
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
  expect(await readLocalFileFromRoots({ filePath, roots: [dir], symlinks: "follow-within-root" })).toBeNull();
});

it.skipIf(process.platform === "win32").each(["/", "/.", "/./"])(
  "rejects a symlink-to-file followed by a directory suffix %s",
  async suffix => {
    const dir = await fixture();
    await fs.symlink("deep/value", path.join(dir, "file-link"));
    const filePath = `${dir}/file-link${suffix}`;
    expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
    expect(await readLocalFileFromRoots({ filePath, roots: [dir], symlinks: "follow-within-root" })).toBeNull();
  },
);

it.skipIf(process.platform === "win32")("cannot cancel an unresolved link target with parent traversal", async () => {
  const dir = await fixture();
  await fs.symlink("missing", path.join(dir, "broken"));
  const filePath = `${dir}/broken/../value`;
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
  expect(await readLocalFileFromRoots({ filePath, roots: [dir], symlinks: "follow-within-root" })).toBeNull();
  expect(resolveLocalPathFromRootsSync({ filePath: path.join(dir, "missing", "future"), roots: [dir], allowMissing: true }))
    .toEqual({ path: path.join(dir, "missing", "future"), root: dir });
});

it.each([false, true])("rejects an outside prefix that normalizes into the root (target exists=%s)", async exists => {
  const base = await tempRoot("fs-safe-local-outside-prefix-");
  const dir = path.join(base, "safe"), outside = path.join(base, "outside", "dir");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "value"), "unrelated inside bytes");
  if (exists) await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(base, "jump"), process.platform === "win32" ? "junction" : "dir");
  const filePath = `${base}${path.sep}jump${path.sep}..${path.sep}safe${path.sep}value`;
  expect(resolveLocalPathFromRootsSync({ filePath, roots: [dir], requireFile: true })).toBeNull();
  expect(await readLocalFileFromRoots({ filePath, roots: [dir], symlinks: "follow-within-root" })).toBeNull();
});
