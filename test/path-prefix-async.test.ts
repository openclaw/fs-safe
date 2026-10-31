import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAbsolutePathForRead, resolvePathPrefix, resolvePathPrefixSync } from "../src/advanced.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("yields while component metadata is pending without synchronous filesystem calls", async () => {
  const directory = await tempRoot("fs-safe-prefix-async-");
  const input = path.join(directory, "future", "child");
  const original = asyncFs.lstat;
  let resume!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { resume = resolve; });
  using lookup = vi.spyOn(asyncFs, "lstat").mockImplementation(async (...args) => {
    started();
    await pending;
    return Reflect.apply(original, asyncFs, args);
  });
  using synchronous = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
    throw new Error("blocking metadata lookup");
  });
  const resolved = resolvePathPrefix(input);
  await entered;
  expect(lookup).toHaveBeenCalledTimes(1);
  resume();
  await expect(resolved).resolves.toEqual({
    absolutePath: input, existingPath: directory, unresolvedSegments: ["future", "child"],
  });
  expect(synchronous).not.toHaveBeenCalled();
});

it("preserves physical symlink parents, raw missing suffixes, and replacement observations", async () => {
  const directory = await tempRoot("fs-safe-prefix-async-links-");
  const target = path.join(directory, "target");
  const replacement = path.join(directory, "replacement");
  const alias = path.join(directory, "alias");
  await asyncFs.mkdir(path.join(target, "child"), { recursive: true });
  await asyncFs.mkdir(path.join(replacement, "child"), { recursive: true });
  const kind = process.platform === "win32" ? "junction" : "dir";
  const input = `${alias}${path.sep}..${path.sep}future${path.sep}..${path.sep}leaf`;
  for (const destination of [target, replacement]) {
    await asyncFs.symlink(path.join(destination, "child"), alias, kind);
    await expect(resolvePathPrefix(input)).resolves.toEqual({
      absolutePath: input, existingPath: destination, unresolvedSegments: ["future", "..", "leaf"],
    });
    await asyncFs.unlink(alias);
  }
});

it("propagates non-directory traversal, symlink loops, and component IO failures", async () => {
  const directory = await tempRoot("fs-safe-prefix-async-errors-");
  const file = path.join(directory, "file");
  await asyncFs.writeFile(file, "fixture");
  for (const suffix of ["/", "/.", "/..", "/child"]) {
    await expect(resolvePathPrefix(file + suffix)).rejects.toMatchObject({ code: "ENOTDIR" });
  }
  if (process.platform !== "win32") {
    const loop = path.join(directory, "loop");
    await asyncFs.symlink("loop", loop);
    await expect(resolvePathPrefix(loop)).rejects.toMatchObject({ code: "ELOOP" });
  }
  const denied = Object.assign(new Error("fixture IO failure"), { code: "EIO" });
  using lookup = vi.spyOn(asyncFs, "lstat").mockRejectedValue(denied);
  await expect(resolvePathPrefix(path.join(directory, "missing"))).rejects.toBe(denied);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "rejects a symlink target crossing an unsearchable directory before parent traversal",
  async () => {
    const directory = await tempRoot("fs-safe-prefix-async-permissions-");
    const locked = path.join(directory, "locked");
    const alias = path.join(directory, "alias");
    await asyncFs.mkdir(locked);
    await asyncFs.mkdir(path.join(directory, "future"));
    await asyncFs.symlink(`${locked}/../future`, alias);
    await asyncFs.chmod(locked, 0);
    try {
      await expect(resolvePathPrefix(alias)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await asyncFs.chmod(locked, 0o700);
    }
  },
);

it.runIf(!process.versions.bun)("resolves absolute reads asynchronously while retaining missing and symlink errors", async () => {
  const directory = await tempRoot("fs-safe-absolute-read-async-");
  const file = path.join(directory, "file");
  const alias = path.join(directory, "alias");
  await asyncFs.writeFile(file, "fixture");
  using synchronous = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
    throw new Error("blocking realpath");
  });
  await expect(resolveAbsolutePathForRead(file)).resolves.toEqual({ path: file, canonicalPath: file });
  await expect(resolveAbsolutePathForRead(path.join(directory, "missing")))
    .rejects.toMatchObject({ code: "not-found" });
  if (process.platform !== "win32") {
    await asyncFs.symlink(file, alias);
    await expect(resolveAbsolutePathForRead(alias, { symlinks: "follow" })).resolves.toEqual({ path: alias, canonicalPath: file });
    await expect(resolveAbsolutePathForRead(alias, { symlinks: "reject" }))
      .rejects.toMatchObject({ code: "symlink" });
  }
  expect(synchronous).not.toHaveBeenCalled();
});

it("matches physical prefix resolution for clean missing paths and link targets", async () => {
  const directory = await tempRoot("fs-safe-prefix-async-missing-");
  const target = path.join(directory, "target");
  await asyncFs.mkdir(path.join(target, "child"), { recursive: true });
  const forms = [
    { name: "plain", prefix: target, existing: target, suffix: ["future", "leaf"] },
  ];
  if (process.platform !== "win32") {
    for (const [name, destination] of [
      ["absolute", target], ["relative", "target"], ["parent", "target/child/.."],
      ["dangling", "target/future/.."],
    ]) {
      const alias = path.join(directory, name!);
      await asyncFs.symlink(destination!, alias);
      forms.push({ name: name!, prefix: alias, existing: target,
        suffix: name === "dangling" ? ["future", "..", "future", "leaf"] : ["future", "leaf"] });
    }
  }
  if (process.platform !== "win32") {
    const alias = path.join(directory, "outside-alias");
    const outsideName = `${path.basename(directory)}-outside-future`;
    const outside = path.join(path.dirname(directory), outsideName);
    await asyncFs.symlink(outside, alias);
    for (const tail of [[], ["child"]]) {
      const input = path.join(alias, ...tail);
      const expected = { absolutePath: input, existingPath: path.dirname(directory),
        unresolvedSegments: [outsideName, ...tail] };
      expect(resolvePathPrefixSync(input)).toEqual(expected);
      await expect(resolvePathPrefix(input)).resolves.toEqual(expected);
    }
  }
  for (const { prefix, existing, suffix } of forms) {
    const input = path.join(prefix, "future", "leaf");
    const expected = { absolutePath: input, existingPath: existing, unresolvedSegments: suffix };
    expect(resolvePathPrefixSync(input)).toEqual(expected);
    await expect(resolvePathPrefix(input)).resolves.toEqual(expected);
  }
});
