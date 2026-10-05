import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree } from "../src/copy.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  getNativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

it.for(["auto", "always"] as const)(
  "handles unavailable cloning after partial progress with clone=%s",
  async (clone, context) => {
    configureFsSafeNative({ mode: "auto" });
    const binding = getNativeBinding();
    if (!binding) {
      context.skip("native binding unavailable");
      return;
    }
    const directory = await tempRoot("fs-safe-tree-clone-fallback-");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.mkdir(path.join(source, "empty"));
    await fs.writeFile(path.join(source, "payload"), "complete source payload");
    await fs.writeFile(path.join(source, "nested", "child"), "nested source payload");
    const failure = Object.assign(new Error("FICLONE denied by seccomp"), {
      code: "CLONE_UNAVAILABLE",
    });
    const cloneTree = vi.fn(async () => {
      await fs.mkdir(path.join(destination, "clone-only"), { recursive: true });
      await fs.writeFile(path.join(destination, "payload"), "partial");
      // Native workers settle before the tree owner removes their partial output.
      await fs.writeFile(path.join(destination, "clone-only", "late-worker"), "residue");
      await fs.rm(destination, { recursive: true });
      throw failure;
    });
    __setNativeLoaderForTest(() => ({
      ...binding,
      probeTreeClone: () => "xfs",
      cloneTree,
    }));

    if (clone === "auto") {
      await copyTree(source, destination, { clone });
      expect((await fs.readdir(destination)).sort()).toEqual(["empty", "nested", "payload"]);
      expect(await fs.readdir(path.join(destination, "empty"))).toEqual([]);
      expect(await fs.readdir(path.join(destination, "nested"))).toEqual(["child"]);
      expect(await fs.readFile(path.join(destination, "payload"), "utf8"))
        .toBe("complete source payload");
      expect(await fs.readFile(path.join(destination, "nested", "child"), "utf8"))
        .toBe("nested source payload");
      await fs.writeFile(path.join(destination, "payload"), "independent copy edit");
    } else {
      await expect(copyTree(source, destination, { clone })).rejects.toMatchObject({
        code: "unsupported-platform",
        cause: failure,
      });
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(cloneTree).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(source, "payload"), "utf8"))
      .toBe("complete source payload");
  },
);

it("refuses to merge the byte fallback into unremoved clone residue", async (context) => {
  configureFsSafeNative({ mode: "auto" });
  const binding = getNativeBinding();
  if (!binding) {
    context.skip("native binding unavailable");
    return;
  }
  const directory = await tempRoot("fs-safe-tree-clone-residue-");
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "payload"), "source payload");
  __setNativeLoaderForTest(() => ({
    ...binding,
    probeTreeClone: () => "xfs",
    async cloneTree() {
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "residue"), "preserve");
      throw Object.assign(new Error("clone unavailable; cleanup failed"), {
        code: "CLONE_UNAVAILABLE",
      });
    },
  }));
  await expect(copyTree(source, destination, { clone: "auto" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await fs.readdir(destination)).toEqual(["residue"]);
  expect(await fs.readFile(path.join(destination, "residue"), "utf8")).toBe("preserve");
});
