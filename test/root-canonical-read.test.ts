import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { resolveRootPath, resolveRootPathSync } from "../src/root-path.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const dir = await tempRoot("fs-safe-canonical-read-");
  await fs.mkdir(path.join(dir, "deep", "dir"), { recursive: true });
  await fs.writeFile(path.join(dir, "deep", "value"), "canonical bytes");
  await fs.writeFile(path.join(dir, "value"), "lexical bytes");
  await fs.symlink(path.join(dir, "deep", "dir"), path.join(dir, "link"),
    process.platform === "win32" ? "junction" : "dir");
  return { dir, scoped: await root(dir) };
}

it.each(["readText", "readAbsolute relative", "readAbsolute absolute", "open", "resolve"])(
  "%s follows symlinks before resolving subsequent parent components",
  async method => {
    const { dir, scoped } = await fixture();
    const relative = `link${path.sep}..${path.sep}value`;
    const absolute = `${dir}${path.sep}${relative}`;
    const options = { symlinks: "follow-within-root" as const };
    const expected = "canonical bytes";
    if (process.platform !== "win32") expect(await fs.readFile(absolute, "utf8")).toBe(expected);
    if (method === "resolve") {
      expect(await scoped.resolve(relative)).toBe(path.join(dir, "deep", "value"));
    } else if (method === "open") {
      const opened = await scoped.open(relative, options);
      try { expect(await opened.handle.readFile("utf8")).toBe(expected); }
      finally { await opened.handle.close(); }
    } else if (method === "readText") {
      expect(await scoped.readText(relative, options)).toBe(expected);
    } else {
      const read = await scoped.readAbsolute(method.endsWith("absolute") ? absolute : relative, options);
      expect(read.buffer.toString("utf8")).toBe(expected);
    }
  },
);

it("retains symlink rejection for readAbsolute spellings containing parent components", async () => {
  const { dir, scoped } = await fixture();
  const relative = `link${path.sep}..${path.sep}value`;
  for (const input of [relative, `${dir}${path.sep}${relative}`]) {
    await expect(scoped.readAbsolute(input)).rejects.toMatchObject({ code: "symlink" });
  }
});

it.each(["readText", "readAbsolute"] as const)("%s preserves traversal after home expansion", async method => {
  const { dir, scoped } = await fixture();
  vi.stubEnv("HOME", dir);
  const relative = `~${path.sep}link${path.sep}..${path.sep}value`;
  const result = await scoped[method](relative, { symlinks: "follow-within-root" });
  expect(typeof result === "string" ? result : result.buffer.toString("utf8")).toBe("canonical bytes");
  await expect(scoped[method](relative)).rejects.toMatchObject({ code: "symlink" });
});

it("preserves raw parent components through both spellings of an aliased root", async () => {
  const { dir } = await fixture();
  const alias = path.join(await tempRoot("fs-safe-read-root-alias-"), "alias");
  await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
  const scoped = await root(alias);
  for (const spelling of [alias, dir]) {
    const read = await scoped.readAbsolute(`${spelling}${path.sep}link${path.sep}..${path.sep}value`, {
      symlinks: "follow-within-root",
    });
    expect(read.buffer.toString("utf8")).toBe("canonical bytes");
  }
});

it("accepts redundant separators after an absolute root prefix", async () => {
  const { dir, scoped } = await fixture();
  const read = await scoped.readAbsolute(`${dir}${path.sep}${path.sep}value`);
  expect(read.buffer.toString("utf8")).toBe("lexical bytes");
});

it("preserves traversal after an absolute spelling re-enters the root", async () => {
  const { dir, scoped } = await fixture();
  const sibling = await tempRoot("fs-safe-read-entry-prefix-");
  expect(path.dirname(sibling)).toBe(path.dirname(dir));
  const raw = `${sibling}${path.sep}..${path.sep}${path.basename(dir)}${path.sep}link${path.sep}..${path.sep}value`;
  const read = await scoped.readAbsolute(raw, { symlinks: "follow-within-root" });
  expect(read.buffer.toString("utf8")).toBe("canonical bytes");
  await expect(scoped.readAbsolute(raw)).rejects.toMatchObject({ code: "symlink" });
});

it("retains the rejection policy for an external symlink before root re-entry", async () => {
  const { dir, scoped } = await fixture();
  const prefix = await tempRoot("fs-safe-external-entry-alias-");
  await fs.symlink(path.join(dir, "deep", "dir"), path.join(prefix, "alias"),
    process.platform === "win32" ? "junction" : "dir");
  await fs.mkdir(path.join(dir, path.basename(dir)));
  await fs.writeFile(path.join(dir, path.basename(dir), "value"), "external alias bytes");
  const raw = `${prefix}${path.sep}alias${path.sep}..${path.sep}..${path.sep}${path.basename(dir)}${path.sep}value`;
  await expect(scoped.readAbsolute(raw)).rejects.toMatchObject({ code: "symlink" });
  const read = await scoped.readAbsolute(raw, { symlinks: "follow-within-root" });
  expect(read.buffer.toString("utf8")).toBe("external alias bytes");
});

it.each(["async", "sync"])("%s resolution resumes inspection after a missing prefix is canceled", async mode => {
  const { dir } = await fixture();
  const params = { rootPath: dir, absolutePath: `${dir}${path.sep}missing${path.sep}..${path.sep}link${path.sep}..${path.sep}value`, boundaryLabel: "fixture" };
  const resolved = mode === "async" ? await resolveRootPath(params) : resolveRootPathSync(params);
  expect(resolved.canonicalPath).toBe(path.join(dir, "deep", "value"));
  const outside = await tempRoot("fs-safe-canonical-outside-");
  await fs.writeFile(path.join(outside, "secret"), "outside bytes");
  await fs.symlink(outside, path.join(dir, "outside"), process.platform === "win32" ? "junction" : "dir");
  const escape = { ...params, absolutePath: `${dir}${path.sep}missing${path.sep}..${path.sep}outside${path.sep}secret` };
  if (mode === "async") await expect(resolveRootPath(escape)).rejects.toThrow("Symlink escapes");
  else expect(() => resolveRootPathSync(escape)).toThrow("Symlink escapes");
});

it.each(["async", "sync"])("%s resolution preserves symlink parents after an outside root alias", async mode => {
  const { dir } = await fixture();
  const alias = path.join(await tempRoot("fs-safe-outside-read-alias-"), "alias");
  await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
  const raw = `${alias}${path.sep}link${path.sep}..${path.sep}value`;
  const params = { rootPath: dir, absolutePath: raw, boundaryLabel: "fixture" };
  const resolved = mode === "async" ? await resolveRootPath(params) : resolveRootPathSync(params);
  expect(resolved.absolutePath).toBe(path.resolve(raw));
  expect(resolved.canonicalPath).toBe(path.join(dir, "deep", "value"));
  if (mode === "async") await expect(resolveRootPath({ ...params, rejectSymlinks: true })).rejects.toMatchObject({ code: "symlink" });
  else expect(() => resolveRootPathSync({ ...params, rejectSymlinks: true })).toThrowError(expect.objectContaining({ code: "symlink" }));
});
