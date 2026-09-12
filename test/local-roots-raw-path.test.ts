import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.unstubAllEnvs());

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
