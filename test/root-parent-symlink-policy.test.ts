import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRootFile, openRootFileSync } from "../src/advanced.js";
import { configureFsSafeNative, root, type Root, type RootWriteOptions } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const parentPolicy = "follow-parents-within-root" as const;
const directoryLink = process.platform === "win32" ? "junction" : "dir";
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-parent-policy-");
  const actual = path.join(directory, "actual");
  await fs.mkdir(actual);
  await fs.writeFile(path.join(actual, "value"), "original");
  await fs.symlink(actual, path.join(directory, "alias"), directoryLink);
  return { directory, actual, safe: await root(directory) };
}

async function readThrough(safe: Root, method: "read" | "open", relative: string) {
  if (method === "read") return (await safe.read(relative, { symlinks: parentPolicy })).buffer.toString();
  const opened = await safe.open(relative, { symlinks: parentPolicy });
  try { return await opened.handle.readFile("utf8"); }
  finally { await opened.handle.close(); }
}

for (const mode of ["off", "auto"] as const) {
  describe(`parent-only symlink policy (native ${mode})`, () => {
    it.each(["read", "open"] as const)("%s permits contained parent aliases and still rejects final aliases", async method => {
      configureFsSafeNative({ mode });
      const { actual, safe } = await fixture();
      expect(await readThrough(safe, method, "alias/value")).toBe("original");
      await expect(safe.readText("alias/value")).rejects.toMatchObject({ code: "symlink" });
      await fs.symlink(path.join(actual, "value"), path.join(actual, "file-link"), "file");
      await fs.symlink(actual, path.join(actual, "directory-link"), directoryLink);
      await fs.symlink(path.join(actual, "missing"), path.join(actual, "dangling-link"), "file");
      for (const name of ["file-link", "directory-link", "directory-link/", "directory-link/.", "dangling-link"]) {
        await expect(readThrough(safe, method, `alias/${name}`)).rejects.toMatchObject({ code: "symlink" });
      }
      expect(await safe.readText("alias/file-link", { symlinks: "follow-within-root" })).toBe("original");
    });

    it("inherits the read policy and allows per-call rejection", async () => {
      configureFsSafeNative({ mode });
      const { directory } = await fixture();
      const safe = await root(directory, { symlinks: parentPolicy });
      expect(await safe.readText("alias/value")).toBe("original");
      await expect(safe.open("alias/value", { symlinks: "reject" })).rejects.toMatchObject({ code: "symlink" });
    });

    it("rejects escaping parents for reads and mutations without changing outside files", async () => {
      configureFsSafeNative({ mode });
      const { directory, safe } = await fixture();
      const outside = await tempRoot("fs-safe-parent-policy-outside-");
      await fs.writeFile(path.join(outside, "value"), "outside");
      await fs.symlink(outside, path.join(directory, "escape"), directoryLink);
      await expect(safe.readText("escape/value", { symlinks: parentPolicy })).rejects.toBeTruthy();
      await expect(safe.write("escape/value", "changed", { mutationSymlinks: parentPolicy })).rejects.toBeTruthy();
      expect(await fs.readFile(path.join(outside, "value"), "utf8")).toBe("outside");
    });

    it("creates missing parents through a contained alias while keeping mutation defaults separate from reads", async () => {
      configureFsSafeNative({ mode });
      const { directory, actual } = await fixture();
      const safe = await root(directory, { mutationSymlinks: parentPolicy });
      await safe.create("alias/new/deep/value", "created");
      expect(await fs.readFile(path.join(actual, "new/deep/value"), "utf8")).toBe("created");
      await expect(safe.readText("alias/new/deep/value")).rejects.toMatchObject({ code: "symlink" });
      await expect(safe.write("alias/value", "denied", { mutationSymlinks: "reject" })).rejects.toBeTruthy();
      expect(await fs.readFile(path.join(actual, "value"), "utf8")).toBe("original");
      const strict = await root(directory, { mutationSymlinks: "reject" });
      await strict.write("alias/value", "allowed", { mutationSymlinks: parentPolicy });
      expect(await fs.readFile(path.join(actual, "value"), "utf8")).toBe("allowed");
    });
  });
}

it.each(["async", "sync"] as const)("openRootFile %s uses the explicit symlink policy before rejectSymlinks", async mode => {
  const { directory, actual } = await fixture();
  const open = mode === "async" ? openRootFile : openRootFileSync;
  const params = { rootPath: directory, boundaryLabel: "fixture", absolutePath: path.join(directory, "alias/value") };
  const opened = await open({ ...params, symlinks: parentPolicy, rejectSymlinks: true });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  try { expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("original"); }
  finally { fsSync.closeSync(opened.fd); }
  const rejected = await open({ ...params, symlinks: "reject", rejectSymlinks: false });
  if (rejected.ok) fsSync.closeSync(rejected.fd);
  expect(rejected).toMatchObject({ ok: false, reason: "validation", error: { code: "symlink" } });
  await fs.symlink(path.join(actual, "value"), path.join(actual, "link"), "file");
  const final = await open({ ...params, absolutePath: path.join(directory, "alias/link"), symlinks: parentPolicy, rejectSymlinks: false });
  if (final.ok) fsSync.closeSync(final.fd);
  expect(final).toMatchObject({ ok: false, reason: "validation", error: { code: "symlink" } });
});

const absoluteAliasCases = [
  { kind: "file" as const, suffix: "" },
  ...["", "/", "/."].map(suffix => ({ kind: "directory" as const, suffix })),
];

async function absoluteAliasFixture(kind: "file" | "directory", suffix: string) {
  const { directory, actual, safe } = await fixture();
  const outside = await tempRoot("fs-safe-root-entry-alias-");
  const parentAlias = path.join(outside, "parent");
  const finalAlias = path.join(outside, "final");
  await fs.symlink(actual, parentAlias, directoryLink);
  await fs.symlink(kind === "file" ? path.join(actual, "value") : actual, finalAlias, kind === "file" ? "file" : directoryLink);
  return { directory, safe, parentPath: path.join(parentAlias, "value"), finalPath: `${finalAlias}${suffix}` };
}

it.each(absoluteAliasCases)("readAbsolute preserves the final $kind alias$suffix policy at absolute root entry", async ({ kind, suffix }) => {
  const { safe, parentPath, finalPath } = await absoluteAliasFixture(kind, suffix);
  expect((await safe.readAbsolute(parentPath, { symlinks: parentPolicy })).buffer.toString()).toBe("original");
  await expect(safe.readAbsolute(finalPath, { symlinks: parentPolicy })).rejects.toMatchObject({ code: "symlink" });
});

it.each(["async", "sync"].flatMap(mode => absoluteAliasCases.map(entry => ({ mode, ...entry }))))(
  "openRootFile $mode preserves the final $kind alias$suffix policy at absolute root entry",
  async ({ mode, kind, suffix }) => {
    const { directory, parentPath, finalPath } = await absoluteAliasFixture(kind, suffix);
    const open = mode === "async" ? openRootFile : openRootFileSync;
    const params = { rootPath: directory, boundaryLabel: "fixture", symlinks: parentPolicy };
    const opened = await open({ ...params, absolutePath: parentPath });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw opened.error;
    try { expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("original"); }
    finally { fsSync.closeSync(opened.fd); }
    const final = await open({ ...params, absolutePath: finalPath, allowedType: kind });
    if (final.ok) fsSync.closeSync(final.fd);
    expect(final).toMatchObject({ ok: false, reason: "validation", error: { code: "symlink" } });
  },
);

const mutations = ["write", "create", "append", "openWritable", "copyIn", "move-source", "move-target", "remove", "mkdir"] as const;
type Mutation = (typeof mutations)[number];

async function mutate(safe: Root, method: Mutation, relative: string, source: string, options: RootWriteOptions) {
  if (method === "openWritable") {
    const opened = await safe.openWritable(relative, options);
    try { await opened.handle.writeFile("changed"); }
    finally { await opened.handle.close(); }
  } else if (method === "copyIn") await safe.copyIn(relative, source, options);
  else if (method === "move-source") await safe.move(relative, "moved", options);
  else if (method === "move-target") await safe.move("source", relative, { ...options, overwrite: true });
  else if (method === "remove" || method === "mkdir") await safe[method](relative, options);
  else await safe[method](relative, "changed", options);
}

it.each(mutations)("%s honors parent-only mutation policy and explicit rejection", async method => {
  const { directory, actual, safe } = await fixture();
  const source = path.join(directory, "source");
  await fs.writeFile(source, "source");
  const name = method === "create" || method === "mkdir" ? "new" : "value";
  const relative = `alias/${name}`;
  await expect(mutate(safe, method, relative, source, { mutationSymlinks: "reject" })).rejects.toBeTruthy();
  expect(await fs.readFile(path.join(actual, "value"), "utf8")).toBe("original");
  expect(await fs.readFile(source, "utf8")).toBe("source");
  await mutate(safe, method, relative, source, { mutationSymlinks: parentPolicy });
  if (method === "remove" || method === "move-source") {
    await expect(fs.lstat(path.join(actual, name))).rejects.toMatchObject({ code: "ENOENT" });
    if (method === "move-source") expect(await fs.readFile(path.join(directory, "moved"), "utf8")).toBe("original");
  } else if (method === "mkdir") expect((await fs.stat(path.join(actual, name))).isDirectory()).toBe(true);
  else {
    expect(await fs.readFile(path.join(actual, name), "utf8")).toBe(
      method === "append" ? "originalchanged" : method === "copyIn" || method === "move-target" ? "source" : "changed",
    );
  }
});

it.each(mutations.flatMap(method => ["contained", "absolute root entry"].map(location => ({ method, location }))))(
  "$method leaves final file, directory, and dangling symlinks untouched ($location)", async ({ method, location }) => {
    const { directory, actual, safe } = await fixture();
    const source = path.join(directory, "source");
    await fs.writeFile(source, "source");
    const linkDirectory = location === "contained" ? actual : await tempRoot("fs-safe-mutation-entry-alias-");
    // POSIX absolute paths fail payload validation; Windows drive paths reach the root checks.
    let code = "symlink";
    if (location === "absolute root entry") {
      if (process.platform !== "win32" && ["move-source", "move-target", "remove", "mkdir"].includes(method)) {
        code = "invalid-path";
      } else if (process.platform === "win32" && (method === "move-source" || method === "move-target")) {
        code = "outside-workspace";
      }
    }
    const targets = [
      { name: "file-link", target: path.join(actual, "value"), kind: "file" as const },
      { name: "directory-link", target: actual, kind: directoryLink },
      { name: "dangling-link", target: path.join(actual, "missing"), kind: "file" as const },
    ];
    for (const { name, target, kind } of targets) {
      const link = path.join(linkDirectory, name);
      await fs.symlink(target, link, kind);
      const input = location === "contained" ? `alias/${name}` : link;
      for (const suffix of kind === directoryLink ? ["", "/", "/."] : [""]) {
        await expect(mutate(safe, method, `${input}${suffix}`, source, { mutationSymlinks: parentPolicy })).rejects.toMatchObject({ code });
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      }
    }
    expect(await fs.readFile(path.join(actual, "value"), "utf8")).toBe("original");
    expect(await fs.readFile(source, "utf8")).toBe("source");
  }
);

it.each(["read", "open"] as const)("%s rejects a final symlink introduced after preview", async method => {
  const { actual, safe } = await fixture();
  const target = path.join(actual, "value");
  let swapped = false;
  __setFsSafeTestHooksForTest({
    async afterPreOpenLstat(candidate) {
      if (candidate !== target || swapped) return;
      swapped = true;
      await fs.rename(target, `${target}.original`);
      await fs.symlink(`${target}.original`, target, "file");
    },
  });
  await expect(readThrough(safe, method, "alias/value")).rejects.toMatchObject({ code: "symlink" });
  expect(swapped).toBe(true);
  expect(await fs.readFile(`${target}.original`, "utf8")).toBe("original");
});

it.each(["append", "create"].flatMap(method => ["symlink", "authority"].map(refusal => ({ method, refusal }))))(
  "$method rechecks $refusal between short writes with both mutation guards enabled", async ({ method, refusal }) => {
    configureFsSafeNative({ mode: "off" });
    const { actual, safe } = await fixture();
    const name = method === "append" ? "value" : "created";
    const target = path.join(actual, name);
    const saved = `${target}.saved`;
    const expired = new Error("mutation owner expired after the first write");
    let active = true;
    let writes = 0;
    const assertBeforeMutation = vi.fn(() => {
      if (!active) throw expired;
    });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) !== target) return handle;
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation((async (buffer, offset, length, position) => {
        writes++;
        const result = await write(buffer, offset, writes === 1 ? Math.min(length, 2) : length, position);
        if (writes === 1) {
          await fs.rename(target, saved);
          if (refusal === "symlink") await fs.symlink(saved, target, "file");
          else {
            await fs.writeFile(target, "replacement");
            active = false;
          }
        }
        return result;
      }) as typeof handle.write);
      return handle;
    });

    const options = { mkdir: false, durable: false, mutationSymlinks: parentPolicy, assertBeforeMutation };
    const pending = method === "append"
      ? safe.append(`alias/${name}`, "abcdef", options)
      : safe.create(`alias/${name}`, "abcdef", options);
    if (refusal === "symlink") await expect(pending).rejects.toMatchObject({ code: "symlink" });
    else await expect(pending).rejects.toBe(expired);
    expect(assertBeforeMutation).toHaveBeenCalled();
    expect(writes).toBe(1);
    expect(await fs.readFile(saved, "utf8")).toBe(method === "append" ? "originalab" : "ab");
    if (refusal === "symlink") expect(await fs.readlink(target)).toBe(saved);
    else expect(await fs.readFile(target, "utf8")).toBe("replacement");
    expect((await fs.readdir(actual)).sort()).toEqual(
      method === "append" ? ["value", "value.saved"] : ["created", "created.saved", "value"],
    );
  },
);

for (const mode of ["off", "require"] as const) {
  it.skipIf(mode === "require" && !nativeAvailable)(`write rejects a final symlink introduced during staging (native ${mode})`, async () => {
    configureFsSafeNative({ mode });
    const { actual, safe } = await fixture();
    const target = path.join(actual, "value");
    const replacement = path.join(actual, "replacement");
    await fs.writeFile(replacement, "replacement");
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      fsSync.renameSync(target, `${target}.original`);
      fsSync.symlinkSync(replacement, target, "file");
    };
    if (mode === "off") {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (path.dirname(String(args[0])) === actual && path.basename(String(args[0])).startsWith(".fs-safe-")) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); swap(); });
        }
        return handle;
      });
    } else {
      const write = fsSync.write.bind(fsSync);
      vi.spyOn(fsSync, "write").mockImplementation(((fd, buffer, offset, length, position, callback) => {
        write(fd, buffer, offset, length, position, (error, bytesWritten, writtenBuffer) => {
          if (!error && bytesWritten > 0 && fsSync.fstatSync(fd).isFile()) swap();
          callback(error, bytesWritten, writtenBuffer);
        });
      }) as typeof fsSync.write);
    }
    await expect(safe.write("alias/value", "changed", { mutationSymlinks: parentPolicy })).rejects.toBeTruthy();
    expect(swapped).toBe(true);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(replacement, "utf8")).toBe("replacement");
    expect(await fs.readFile(`${target}.original`, "utf8")).toBe("original");
    expect((await fs.readdir(actual)).sort()).toEqual(["replacement", "value", "value.original"]);
  });
}
