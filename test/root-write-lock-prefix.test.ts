import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { createRootWriteLockBinding } from "../src/root-write-lock-binding.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const bindings: ReturnType<typeof createRootWriteLockBinding>[] = [];
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

function createBinding(rootPath: string, targetPath: string) {
  const binding = createRootWriteLockBinding({ rootPath, targetPath });
  bindings.push(binding);
  return binding;
}

afterEach(() => {
  for (const binding of bindings.splice(0)) binding.dispose();
  vi.restoreAllMocks();
});

describe("compatibility lock missing-prefix observations", () => {
  it("keeps the ordinary leaf check when the parent already exists", async () => {
    const directory = await tempRoot("fs-safe-lock-existing-parent-");
    const parent = path.join(directory, ...Array.from({ length: 32 }, (_, index) => `d${index}`));
    await fs.mkdir(parent, { recursive: true });
    const target = path.join(parent, "target");
    const binding = createBinding(directory, target);
    const resolve = vi.spyOn(realpathSync, "native");
    const observe = vi.spyOn(fsSync, "lstatSync");

    binding.assertCurrent();
    binding.assertCurrent();

    expect(resolve.mock.calls.map(([candidate]) => candidate)).toEqual([target, parent, target, parent]);
    expect(observe.mock.calls.map(([candidate]) => candidate)).toEqual([target, parent, target, parent]);
  });

  it("advances through created parents without repeatedly searching the unreachable suffix", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-depth-");
    const parts = Array.from({ length: 32 }, (_, index) => `level-${index}`);
    const target = path.join(directory, ...parts, "target");
    const binding = createBinding(directory, target);
    const resolve = vi.spyOn(realpathSync, "native");
    const observe = vi.spyOn(fsSync, "lstatSync");
    let parent = directory;

    binding.assertCurrent();
    for (const part of parts) {
      parent = path.join(parent, part);
      await fs.mkdir(parent);
      binding.assertCurrent();
    }

    expect(resolve.mock.calls.some(([candidate]) => candidate === target)).toBe(false);
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(2 * (parts.length + 1));
    expect(observe.mock.calls.length).toBeLessThanOrEqual(6 * (parts.length + 1));
    await fs.writeFile(target, "created");
    binding.assertCurrent();
    expect(resolve).toHaveBeenLastCalledWith(target);
    expect(await fs.readFile(target, "utf8")).toBe("created");
  });

  it("retreats through the full resolver when the hinted ancestor was removed", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-removal-");
    const ancestor = path.join(directory, "ancestor");
    const parent = path.join(ancestor, "parent");
    const target = path.join(parent, "missing", "target");
    await fs.mkdir(parent, { recursive: true });
    const binding = createBinding(directory, target);
    binding.assertCurrent();
    await fs.rm(ancestor, { recursive: true });
    const resolve = vi.spyOn(realpathSync, "native");

    expect(binding.assertCurrent).not.toThrow();
    expect(resolve).toHaveBeenCalledWith(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    expect(binding.assertCurrent).not.toThrow();
    expect(binding.targetPath).toBe(target);
    expect(await fs.readdir(path.dirname(target))).toEqual([]);
  });

  it("allows a fresh directory at the same path because the lock destination is unchanged", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-replacement-");
    const parent = path.join(directory, "parent");
    const target = path.join(parent, "missing", "target");
    await fs.mkdir(parent);
    const binding = createBinding(directory, target);
    binding.assertCurrent();
    await fs.rename(parent, path.join(directory, "retired"));
    await fs.mkdir(parent);
    const resolve = vi.spyOn(realpathSync, "native");

    expect(binding.assertCurrent).not.toThrow();
    expect(resolve).not.toHaveBeenCalledWith(target);
    expect(binding.targetPath).toBe(target);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("rejects ancestor retargeting even when the observed directory keeps its identity", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-retarget-");
    const ancestor = path.join(directory, "ancestor");
    const parent = path.join(ancestor, "parent");
    const relocated = path.join(directory, "relocated");
    const target = path.join(parent, "missing", "target");
    await fs.mkdir(parent, { recursive: true });
    const binding = createBinding(directory, target);
    binding.assertCurrent();
    await fs.rename(ancestor, relocated);
    await fs.symlink(relocated, ancestor, directoryLinkType);

    expect(binding.assertCurrent).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(await fs.readdir(path.join(relocated, "parent"))).toEqual([]);
  });

  it.each([false, true])("re-resolves a first missing child which becomes an alias (outside=%s)", async outside => {
    const directory = await tempRoot("fs-safe-lock-prefix-alias-");
    const destinationRoot = outside ? await tempRoot("fs-safe-lock-prefix-outside-") : directory;
    const other = path.join(destinationRoot, "other");
    await fs.mkdir(other);
    const firstMissing = path.join(directory, "missing");
    const target = path.join(firstMissing, "child", "target");
    const binding = createBinding(directory, target);
    binding.assertCurrent();
    await fs.symlink(other, firstMissing, directoryLinkType);
    const resolve = vi.spyOn(realpathSync, "native");

    expect(binding.assertCurrent).toThrow(expect.objectContaining({
      code: outside ? "path-alias" : "path-mismatch",
    }));
    expect(resolve).toHaveBeenCalledWith(target);
    expect(await fs.readdir(other)).toEqual([]);
  });

  it("does not hide an existing dangling link behind the cached missing suffix", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-dangling-");
    const firstMissing = path.join(directory, "missing");
    const target = path.join(firstMissing, "child", "target");
    const binding = createBinding(directory, target);
    binding.assertCurrent();
    await fs.symlink(path.join(directory, "absent"), firstMissing, directoryLinkType);

    expect(binding.assertCurrent).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => createBinding(directory, target)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("leaves an intermediate file collision to the full resolver and guarded writer", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-file-");
    const firstMissing = path.join(directory, "missing");
    const target = path.join(firstMissing, "child", "target");
    const binding = createBinding(directory, target);
    binding.assertCurrent();
    await fs.writeFile(firstMissing, "collision");
    const resolve = vi.spyOn(realpathSync, "native");

    // Lock selection binds the same prospective name; directory admission is
    // separately responsible for rejecting the file as a parent.
    expect(binding.assertCurrent).not.toThrow();
    expect(resolve).toHaveBeenCalledWith(target);
    expect(createBinding(directory, target).targetPath).toBe(target);
    expect(await fs.readFile(firstMissing, "utf8")).toBe("collision");
  });

  it("uses full resolution when a previously missing final target becomes a link", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-final-link-");
    const target = path.join(directory, "target");
    const other = path.join(directory, "other");
    await fs.mkdir(other);
    const binding = createBinding(directory, target);
    binding.assertCurrent();
    await fs.symlink(other, target, directoryLinkType);
    const resolve = vi.spyOn(realpathSync, "native");

    expect(binding.assertCurrent).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(resolve).toHaveBeenCalledWith(target);
    expect(await fs.readdir(other)).toEqual([]);
  });

  it("does not retain raw missing components normalized out of the selected lock path", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-normalized-route-");
    const target = path.join(directory, "target");
    const rawTarget = `${directory}${path.sep}missing${path.sep}..${path.sep}target`;
    const other = path.join(directory, "other");
    await fs.mkdir(other);
    const binding = createBinding(directory, rawTarget);
    expect(binding.targetPath).toBe(target);
    await fs.symlink(other, target, directoryLinkType);

    expect(binding.assertCurrent).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });

  it("keeps an existing final directory link bound to its selected canonical destination", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-selected-link-");
    const alias = path.join(directory, "alias");
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.symlink(first, alias, directoryLinkType);
    const binding = createBinding(directory, alias);
    expect(binding.targetPath).toBe(first);
    expect(binding.relativeLockPath).toBe("first");
    await fs.unlink(alias);
    await fs.symlink(second, alias, directoryLinkType);
    expect(binding.assertCurrent).not.toThrow();
    await fs.rename(first, path.join(directory, "retired"));
    await fs.symlink(second, first, directoryLinkType);

    expect(binding.assertCurrent).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });

  itPosix("keeps an existing final file link bound to its selected canonical destination", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-selected-file-link-");
    const alias = path.join(directory, "alias");
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    await fs.writeFile(first, "first");
    await fs.writeFile(second, "second");
    await fs.symlink(first, alias);
    const binding = createBinding(directory, alias);
    expect(binding.targetPath).toBe(first);
    await fs.unlink(alias);
    await fs.symlink(second, alias);

    expect(binding.assertCurrent).not.toThrow();
    expect(binding.relativeLockPath).toBe("first");
    expect(await fs.readFile(first, "utf8")).toBe("first");
  });

  it("uses the full resolver's error when a speculative prefix probe is denied", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-denied-");
    const target = path.join(directory, "missing", "target");
    const binding = createBinding(directory, target);
    const prefixFailure = Object.assign(new Error("prefix resolution denied"), { code: "EACCES" });
    const targetFailure = Object.assign(new Error("target resolution denied"), { code: "EACCES" });
    const realpath = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      if (candidate === directory) throw prefixFailure;
      if (candidate === target) throw targetFailure;
      return realpath(candidate);
    });

    expect(binding.assertCurrent).toThrow(targetFailure);
  });

  it("falls back when a prefix observation does not provide exact bigint identity", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-unknown-identity-");
    const target = path.join(directory, "missing", "target");
    const binding = createBinding(directory, target);
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate, options) => {
      const observed = lstat(candidate, options as { bigint: true });
      if (candidate === directory && typeof options === "object" && options?.bigint) {
        Object.defineProperty(observed, "dev", { value: Number(observed.dev) });
      }
      return observed;
    }) as typeof fsSync.lstatSync);
    const resolve = vi.spyOn(realpathSync, "native");

    expect(binding.assertCurrent).not.toThrow();
    expect(resolve).toHaveBeenCalledWith(target);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("discards the hint when the prefix identity changes during canonicalization", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-identity-fence-");
    const parent = path.join(directory, "parent");
    const target = path.join(parent, "missing", "target");
    await fs.mkdir(parent);
    const binding = createBinding(directory, target);
    const realpath = realpathSync.native;
    let swapped = false;
    const resolve = vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      if (!swapped && candidate === parent) {
        swapped = true;
        fsSync.renameSync(parent, path.join(directory, "retired"));
        fsSync.mkdirSync(parent);
      }
      return realpath(candidate);
    });

    expect(binding.assertCurrent).not.toThrow();
    expect(swapped).toBe(true);
    expect(resolve).toHaveBeenCalledWith(target);
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("rechecks absence when a link appears during the prefix canonical observation", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-absence-fence-");
    const firstMissing = path.join(directory, "missing");
    const target = path.join(firstMissing, "target");
    const other = path.join(directory, "other");
    await fs.mkdir(other);
    const binding = createBinding(directory, target);
    const realpath = realpathSync.native;
    let inserted = false;
    const resolve = vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      if (!inserted && candidate === directory) {
        inserted = true;
        fsSync.symlinkSync(other, firstMissing, directoryLinkType);
      }
      return realpath(candidate);
    });

    expect(binding.assertCurrent).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inserted).toBe(true);
    expect(resolve).toHaveBeenCalledWith(target);
    expect(await fs.readdir(other)).toEqual([]);
  });

  it("checks canonical spelling after the final missing-child probe can relocate an ancestor", async () => {
    const directory = await tempRoot("fs-safe-lock-prefix-final-name-fence-");
    const ancestor = path.join(directory, "ancestor");
    const parent = path.join(ancestor, "parent");
    const relocated = path.join(directory, "relocated");
    const firstMissing = path.join(parent, "missing");
    const target = path.join(firstMissing, "target");
    await fs.mkdir(parent, { recursive: true });
    const binding = createBinding(directory, target);
    const lstat = fsSync.lstatSync;
    let swapped = false;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate, options) => {
      if (!swapped && candidate === firstMissing && options === undefined) {
        swapped = true;
        fsSync.renameSync(ancestor, relocated);
        fsSync.symlinkSync(relocated, ancestor, directoryLinkType);
      }
      return lstat(candidate, options as { bigint: true });
    }) as typeof fsSync.lstatSync);

    expect(binding.assertCurrent).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(swapped).toBe(true);
    expect(await fs.readdir(path.join(relocated, "parent"))).toEqual([]);
  });
});
