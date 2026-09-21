import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as canonical from "../src/realpath.js";
import {
  resolvePathViaExistingAncestor,
  resolvePathViaExistingAncestorSync,
} from "../src/root-path-existing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each(["native", "ordinary"] as const)(
  "%s keeps a normalized missing suffix beneath the selected physical ancestor",
  async mode => {
    const directory = await tempRoot("fs-safe-ancestor-suffix-");
    const selected = path.join(directory, "selected");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(selected);
    fs.symlinkSync(selected, alias, process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(path.join(selected, "existing"), "content");
    const resolve = mode === "native" ? resolvePathViaExistingAncestor : resolvePathViaExistingAncestorSync;

    for (const [suffix, expected] of [
      ["", selected],
      ["existing", path.join(selected, "existing")],
      ["one/two/value", path.join(selected, "one", "two", "value")],
      ["one/../two/value", path.join(selected, "two", "value")],
    ]) {
      await expect(Promise.resolve(resolve(`${alias}${path.sep}${suffix}`))).resolves.toBe(expected);
    }
  },
);

it.each(["native", "ordinary"] as const)(
  "%s reconstructs a missing suffix at the filesystem root",
  async mode => {
    const sourceRoot = path.parse(path.resolve(".")).root;
    const canonicalRoot = sourceRoot;
    const target = path.join(sourceRoot, "missing", "nested", "leaf");
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike) =>
      String(candidate) === sourceRoot ? {} : undefined) as typeof fs.lstatSync);
    vi.spyOn(fs, "existsSync").mockImplementation(candidate => String(candidate) === sourceRoot);
    const realpath = mode === "native" ? vi.spyOn(canonical.realpathSync, "native") : vi.spyOn(canonical, "realpathSync");
    realpath.mockReturnValue(canonicalRoot);
    const resolve = mode === "native" ? resolvePathViaExistingAncestor : resolvePathViaExistingAncestorSync;

    await expect(Promise.resolve(resolve(target))).resolves.toBe(target);
    expect(realpath).toHaveBeenCalledExactlyOnceWith(sourceRoot);
  },
);

it.runIf(process.platform === "win32").each(["native", "ordinary"] as const)(
  "%s preserves drive and namespace suffix spelling after root canonicalization",
  async mode => {
    const resolve = mode === "native" ? resolvePathViaExistingAncestor : resolvePathViaExistingAncestorSync;
    for (const [target, ancestor, expected] of [
      ["C:\\one\\two", "C:\\", "D:\\canonical\\one\\two"],
      ["\\\\server\\share\\one\\two", "\\\\server\\share\\", "D:\\canonical\\one\\two"],
      ["\\\\?\\C:\\one\\two", "C:\\", "D:\\canonical\\one\\two"],
      ["\\\\.\\C:\\one\\two", "C:\\", "D:\\canonical\\one\\two"],
      ["\\\\?\\C:\\Name/../conın$.txt/..//..", "\\", "D:\\canonical\\?"],
    ]) {
      vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike) =>
        String(candidate) === ancestor ? {} : undefined) as typeof fs.lstatSync);
      vi.spyOn(fs, "existsSync").mockImplementation(candidate => String(candidate) === ancestor);
      const realpath = mode === "native" ? vi.spyOn(canonical.realpathSync, "native") : vi.spyOn(canonical, "realpathSync");
      realpath.mockReturnValue("D:\\canonical");

      await expect(Promise.resolve(resolve(target))).resolves.toBe(expected);
      expect(realpath).toHaveBeenCalledExactlyOnceWith(ancestor);
      vi.restoreAllMocks();
    }
  },
);
