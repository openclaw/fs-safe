import fsSync from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { root as openRoot } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createFifo(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("mkfifo", [filePath]);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mkfifo exited ${String(code)}`));
    });
  });
}

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("path stress regressions", () => {
  it.runIf(process.platform !== "win32")(
    "rejects stable intermediate symlinks unless following is explicit",
    async () => {
      const rootDir = await tempRoot("fs-safe-intermediate-symlink-");
      await fs.mkdir(path.join(rootDir, "real"));
      await fs.writeFile(path.join(rootDir, "real", "value.txt"), "inside");
      await fs.symlink("real", path.join(rootDir, "alias"), "dir");
      const scoped = await openRoot(rootDir);

      await expect(scoped.readText("alias/value.txt")).rejects.toMatchObject({
        code: "symlink",
      });
      await expect(
        scoped.readText("alias/value.txt", { symlinks: "follow-within-root" }),
      ).resolves.toBe("inside");

      const syncStore = fileStoreSync({ rootDir });
      expect(() => syncStore.readTextIfExists("alias/value.txt")).toThrow(
        expect.objectContaining({ code: "path-mismatch" }),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports an intermediate symlink loop as a symlink failure when following",
    async () => {
      const rootDir = await tempRoot("fs-safe-symlink-loop-");
      await fs.symlink("loop-b", path.join(rootDir, "loop-a"), "dir");
      await fs.symlink("loop-a", path.join(rootDir, "loop-b"), "dir");
      const scoped = await openRoot(rootDir);

      await expect(
        scoped.readText("loop-a/value.txt", { symlinks: "follow-within-root" }),
      ).rejects.toMatchObject({ code: "symlink" });
    },
  );

  it("detects an in-root parent-directory swap between lstat and open", async () => {
    const rootDir = await tempRoot("fs-safe-parent-swap-");
    const targetDir = path.join(rootDir, "target");
    const replacementDir = path.join(rootDir, "replacement");
    const displacedDir = path.join(rootDir, "displaced");
    await fs.mkdir(targetDir);
    await fs.mkdir(replacementDir);
    await fs.writeFile(path.join(targetDir, "value.txt"), "trusted");
    await fs.writeFile(path.join(replacementDir, "value.txt"), "replacement");
    const scoped = await openRoot(rootDir);
    const targetFile = path.join(scoped.rootReal, "target", "value.txt");
    let swapped = false;
    __setFsSafeTestHooksForTest({
      async afterPreOpenLstat(filePath) {
        if (swapped || filePath !== targetFile) {
          return;
        }
        swapped = true;
        await fs.rename(targetDir, displacedDir);
        await fs.rename(replacementDir, targetDir);
      },
    });

    await expect(scoped.readText("target/value.txt")).rejects.toMatchObject({
      code: "path-mismatch",
    });
    await expect(fs.readFile(path.join(displacedDir, "value.txt"), "utf8")).resolves.toBe(
      "trusted",
    );
  });

  it.runIf(process.platform !== "win32")(
    "opens reads nonblocking so a raced FIFO is rejected without hanging",
    async () => {
      const rootDir = await tempRoot("fs-safe-root-fifo-swap-");
      const scoped = await openRoot(rootDir);
      const filePath = path.join(scoped.rootReal, "value.txt");
      const displacedPath = path.join(scoped.rootReal, "value.displaced");
      await fs.writeFile(filePath, "regular");
      let swapped = false;
      __setFsSafeTestHooksForTest({
        async beforeOpen(openedPath, flags) {
          if (swapped || openedPath !== filePath) {
            return;
          }
          expect(flags & fsSync.constants.O_NONBLOCK).toBe(fsSync.constants.O_NONBLOCK);
          swapped = true;
          await fs.rename(filePath, displacedPath);
          await createFifo(filePath);
        },
      });

      await expect(scoped.readText("value.txt")).rejects.toMatchObject({ code: "not-file" });
      expect(swapped).toBe(true);
    },
  );

  it("does not canonicalize whitespace-padded FileStore keys onto another key", async () => {
    const rootDir = await tempRoot("fs-safe-store-whitespace-");
    const asyncStore = fileStore({ rootDir });
    const syncStore = fileStoreSync({ rootDir });
    await asyncStore.writeText("value.txt", "kept");

    for (const key of [" value.txt", "value.txt "]) {
      expect(() => asyncStore.path(key), key).toThrow(
        expect.objectContaining({ code: "invalid-path" }),
      );
      expect(() => syncStore.path(key), key).toThrow(
        expect.objectContaining({ code: "invalid-path" }),
      );
    }
    expect(fsSync.readFileSync(path.join(rootDir, "value.txt"), "utf8")).toBe("kept");
  });

  it.runIf(process.platform !== "win32")(
    "classifies an OS-rejected overlong root path as invalid input rather than an escape",
    async () => {
      const rootDir = await tempRoot("fs-safe-overlong-path-");
      const scoped = await openRoot(rootDir);

      await expect(scoped.readText("x".repeat(10_000))).rejects.toMatchObject({
        code: "invalid-path",
      });
    },
  );
});
