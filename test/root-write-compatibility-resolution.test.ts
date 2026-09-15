import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pinnedWrite from "../src/pinned-write.js";
import { realpathSync } from "../src/realpath.js";
import { withRootFallbackCompatibilityLock } from "../src/root-write-compatibility.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

beforeEach(() => {
  // Isolate destination resolution from the independently tested sidecar I/O.
  vi.spyOn(pinnedWrite, "withPinnedWriteRenameIdentityLock")
    .mockImplementation(async (_params, run) => await run());
});
afterEach(() => vi.restoreAllMocks());

describe("Root compatibility destination resolution", () => {
  it("resolves an existing destination once before dispatch and freshly at every mutation", async () => {
    const directory = await tempRoot("fs-safe-lock-resolution-");
    const target = path.join(directory, "target");
    await fs.writeFile(target, "previous");
    const resolve = vi.spyOn(realpathSync, "native");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const mutation = vi.fn();

    await withRootFallbackCompatibilityLock({
      rootPath: directory, targetPath: target, assertBeforeMutation: mutation,
    }, async binding => {
      expect(binding).toMatchObject({ targetPath: target, relativePath: "target" });
      expect(resolve.mock.calls).toEqual([[target]]);
      expect(lstat).not.toHaveBeenCalled();
      for (let pass = 1; pass <= 2; pass++) {
        binding.assertBeforeMutation();
        expect(resolve).toHaveBeenCalledTimes(pass + 1);
        expect(mutation).toHaveBeenCalledTimes(pass);
      }
    });
    expect(pinnedWrite.withPinnedWriteRenameIdentityLock).toHaveBeenCalledWith({
      rootPath: directory, targetPath: target, relativeTargetPath: "target",
    }, expect.any(Function));
    expect(lstat).not.toHaveBeenCalled();
  });

  it.each(["after lock selection", "inside mutation callback"])(
    "rejects a changed effective destination %s", async phase => {
      const directory = await tempRoot("fs-safe-lock-resolution-change-");
      const target = path.join(directory, "target"), other = path.join(directory, "other");
      await fs.writeFile(target, "previous");
      let changed = false;
      const resolve = realpathSync.native;
      vi.spyOn(realpathSync, "native").mockImplementation(candidate =>
        candidate === target && changed ? other : resolve(candidate));
      vi.mocked(pinnedWrite.withPinnedWriteRenameIdentityLock).mockImplementation(async (_params, run) => {
        if (phase === "after lock selection") changed = true;
        return await run();
      });
      const mutate = vi.fn(() => { changed = true; });
      await expect(withRootFallbackCompatibilityLock({
        rootPath: directory, targetPath: target, assertBeforeMutation: mutate,
      }, async binding => binding.assertBeforeMutation())).rejects.toMatchObject({ code: "path-mismatch" });
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(target, "utf8")).toBe("previous");
    },
  );

  it("keeps missing-component resolution bounded by the existing root", async () => {
    const directory = await tempRoot("fs-safe-lock-resolution-missing-");
    const parent = path.join(directory, "missing");
    const target = path.join(parent, "target");
    const resolve = vi.spyOn(realpathSync, "native");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    await withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: target }, async binding => {
      expect(binding).toMatchObject({ targetPath: target, relativePath: "missing/target" });
    });
    expect(resolve.mock.calls).toEqual([[target], [directory]]);
    expect(lstat.mock.calls.map(([candidate]) => candidate)).toEqual([target, parent, directory]);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["ENOENT", "ENOTDIR"])("does not treat an existing unresolved path as missing (%s)", async code => {
    const directory = await tempRoot("fs-safe-lock-resolution-unresolved-");
    const target = path.join(directory, "target");
    await fs.writeFile(target, "previous");
    const failure = Object.assign(new Error("canonical resolution failed"), { code });
    const realpath = realpathSync.native;
    const resolve = vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      if (candidate === target) throw failure;
      return realpath(candidate);
    });
    // A dangling link has this same shape: realpath reports missing, but lstat
    // still sees the entry. The ancestor fallback must not bypass that entry.
    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expect(withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: target }, vi.fn()))
      .rejects.toBe(failure);
    expect(resolve.mock.calls).toEqual([[target], [target]]);
    expect(lstat.mock.calls.map(([candidate]) => candidate)).toEqual([target]);
    expect(pinnedWrite.withPinnedWriteRenameIdentityLock).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "EIO"])("propagates %s without selecting a lexical lock", async code => {
    const directory = await tempRoot("fs-safe-lock-resolution-denied-");
    const target = path.join(directory, "target");
    const failure = Object.assign(new Error("canonical resolution denied"), { code });
    vi.spyOn(realpathSync, "native").mockImplementation(() => { throw failure; });
    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expect(withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: target }, vi.fn()))
      .rejects.toBe(failure);
    expect(lstat).not.toHaveBeenCalled();
    expect(pinnedWrite.withPinnedWriteRenameIdentityLock).not.toHaveBeenCalled();
  });

  it.each(["UPPER", "caf\u00e9", "file name", "trailing."])(
    "retains lower-case ASCII lock admission for an existing effective spelling %s", async spelling => {
      const directory = await tempRoot("fs-safe-lock-resolution-spelling-");
      const target = path.join(directory, "target");
      // Model the resolver result so Windows filename normalization cannot
      // silently change the unsupported spelling used by this admission test.
      vi.spyOn(realpathSync, "native").mockReturnValue(path.join(directory, spelling));
      await expect(withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: target }, vi.fn()))
        .rejects.toMatchObject({ code: "path-alias" });
      expect(pinnedWrite.withPinnedWriteRenameIdentityLock).not.toHaveBeenCalled();
    },
  );
});
