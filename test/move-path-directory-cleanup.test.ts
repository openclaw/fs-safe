import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => vi.restoreAllMocks());

async function fixture(nested = false) {
  const base = await tempRoot("fs-safe-move-directory-cleanup-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  const directory = nested ? path.join(source, "nested") : source;
  const child = path.join(directory, "payload");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(child, "copied");
  return {
    source, target, directory, child,
    parked: path.join(base, "parked"),
    publishedChild: path.join(target, ...(nested ? ["nested"] : []), "payload"),
  };
}

function afterChildUnlink(child: string, action: () => Promise<void> | void) {
  const unlink = fs.unlink;
  return vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
    await unlink(candidate);
    if (candidate === child) await action();
  });
}

describe("copied-source directory cleanup", () => {
  describe.each([false, true])("nested=%s", (nested) => {
    it.each(["directory", "file", "missing"] as const)(
      "reports a %s replacement during child cleanup as stale", async (replacement) => {
        const move = await fixture(nested);
        const original = await fs.lstat(move.directory);
        const published = vi.fn();
        const mutation = vi.fn();
        let mutationCountAtReplacement = 0;
        let replaced = false;
        afterChildUnlink(move.child, async () => {
          expect(published).toHaveBeenCalledTimes(1);
          await fs.rename(move.directory, move.parked);
          if (replacement === "directory") await fs.mkdir(move.directory);
          if (replacement === "file") await fs.writeFile(move.directory, "replacement");
          mutationCountAtReplacement = mutation.mock.calls.length;
          replaced = true;
        });
        const rmdir = vi.spyOn(fs, "rmdir");

        await expect(movePathWithCopyFallback({
          from: move.source,
          to: move.target,
          sourceHardlinks: "reject",
          onDestinationPublished: published,
          assertBeforeMutation: mutation,
        })).rejects.toMatchObject({ code: "ESTALE" });

        expect(replaced).toBe(true);
        expect(rmdir).not.toHaveBeenCalledWith(move.directory);
        // A surviving outer directory may still attempt its own empty removal.
        expect(mutation).toHaveBeenCalledTimes(mutationCountAtReplacement + (nested ? 1 : 0));
        expect(published).toHaveBeenCalledTimes(1);
        const destination = await fs.lstat(move.target, { bigint: true });
        expect(published).toHaveBeenCalledWith({
          path: move.target, dev: destination.dev, ino: destination.ino,
        });
        await expect(fs.readFile(move.publishedChild, "utf8")).resolves.toBe("copied");
        await expect(fs.readdir(move.parked)).resolves.toEqual([]);
        await expect(fs.lstat(move.parked)).resolves.toMatchObject({ dev: original.dev, ino: original.ino });
        if (replacement === "directory") {
          expect((await fs.lstat(move.directory)).ino).not.toBe(original.ino);
          await expect(fs.readdir(move.directory)).resolves.toEqual([]);
        } else if (replacement === "file") {
          await expect(fs.readFile(move.directory, "utf8")).resolves.toBe("replacement");
        } else {
          await expect(fs.lstat(move.directory)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
    );
  });

  it("removes unchanged directories despite metadata changes from child cleanup", async () => {
    const move = await fixture(true);
    await fs.mkdir(path.join(move.source, "empty"));
    await fs.writeFile(path.join(move.source, "sibling"), "sibling");

    await movePathWithCopyFallback({
      from: move.source, to: move.target, sourceHardlinks: "reject",
    });

    await expect(fs.lstat(move.source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(move.publishedChild, "utf8")).resolves.toBe("copied");
    await expect(fs.readFile(path.join(move.target, "sibling"), "utf8")).resolves.toBe("sibling");
    await expect(fs.readdir(path.join(move.target, "empty"))).resolves.toEqual([]);
  });

  it("preserves unrelated children added while removing a copied child", async () => {
    const move = await fixture();
    afterChildUnlink(move.child, () => fs.writeFile(path.join(move.source, "late"), "late"));

    await expect(movePathWithCopyFallback({
      from: move.source, to: move.target, sourceHardlinks: "reject",
    })).rejects.toMatchObject({ code: "ESTALE" });

    await expect(fs.readdir(move.source)).resolves.toEqual(["late"]);
    await expect(fs.readFile(path.join(move.source, "late"), "utf8")).resolves.toBe("late");
    await expect(fs.readFile(move.publishedChild, "utf8")).resolves.toBe("copied");
    await expect(fs.readdir(move.target)).resolves.toEqual(["payload"]);
  });

  it("propagates a final directory observation error without attempting removal", async () => {
    const move = await fixture();
    const denied = Object.assign(new Error("directory observation denied"), { code: "EACCES" });
    let childRemoved = false;
    afterChildUnlink(move.child, () => { childRemoved = true; });
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      if (childRemoved && candidate === move.source) throw denied;
      return lstat(candidate, options as never);
    });
    const rmdir = vi.spyOn(fs, "rmdir");

    await expect(movePathWithCopyFallback({
      from: move.source, to: move.target, sourceHardlinks: "reject",
    })).rejects.toBe(denied);

    expect(childRemoved).toBe(true);
    expect(rmdir).not.toHaveBeenCalled();
    await expect(fs.readdir(move.source)).resolves.toEqual([]);
    await expect(fs.readFile(move.publishedChild, "utf8")).resolves.toBe("copied");
  });

  it("checks mutation authority after the final directory observation", async () => {
    const move = await fixture();
    const denied = Object.assign(new Error("owner expired"), { code: "ENOTEMPTY" });
    let childRemoved = false;
    let finalObservation = false;
    afterChildUnlink(move.child, () => { childRemoved = true; });
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      const stat = lstat(candidate, options as never);
      if (childRemoved && candidate === move.source) finalObservation = true;
      return stat;
    });
    const rmdir = vi.spyOn(fs, "rmdir");

    await expect(movePathWithCopyFallback({
      from: move.source,
      to: move.target,
      sourceHardlinks: "reject",
      assertBeforeMutation: () => {
        if (finalObservation) throw denied;
      },
    })).rejects.toBe(denied);

    expect(finalObservation).toBe(true);
    expect(rmdir).not.toHaveBeenCalled();
    await expect(fs.readdir(move.source)).resolves.toEqual([]);
    await expect(fs.readFile(move.publishedChild, "utf8")).resolves.toBe("copied");
  });

  it.each(["ENOTEMPTY", "EEXIST", "EACCES", "ENOENT"])(
    "preserves the existing rmdir %s error behavior", async (code) => {
      const move = await fixture();
      const failed = Object.assign(new Error("directory removal failed"), { code });
      const rmdir = fs.rmdir;
      vi.spyOn(fs, "rmdir").mockImplementation(async (candidate, options) => {
        if (candidate === move.source) throw failed;
        await rmdir(candidate, options);
      });
      const result = movePathWithCopyFallback({
        from: move.source, to: move.target, sourceHardlinks: "reject",
      });
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        await expect(result).rejects.toMatchObject({ code: "ESTALE" });
      } else {
        await expect(result).rejects.toBe(failed);
      }

      await expect(fs.readdir(move.source)).resolves.toEqual([]);
      await expect(fs.readFile(move.publishedChild, "utf8")).resolves.toBe("copied");
    },
  );
});
