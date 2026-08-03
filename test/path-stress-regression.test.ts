import fsSync from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError, expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { root as openRoot } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const { tempRoot } = useTempDirs();


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
  vi.restoreAllMocks();
});

describe("path stress regressions", () => {
  itPosix("serializes same-target writes before resolving the existing target", async () => {
    const rootDir = await tempRoot("fs-safe-write-resolution-queue-");
    const scoped = await openRoot(rootDir);
    const targetPath = path.join(scoped.rootReal, "state.txt");
    await scoped.write("state.txt", "initial");

    let activeTargetOpens = 0;
    let maxActiveTargetOpens = 0;
    let heldFirstOpen = false;
    let signalFirstOpen!: () => void;
    const firstOpen = new Promise<void>((resolve) => {
      signalFirstOpen = resolve;
    });
    __setFsSafeTestHooksForTest({
      async afterOpen(filePath) {
        if (filePath !== targetPath) {
          return;
        }
        activeTargetOpens += 1;
        maxActiveTargetOpens = Math.max(maxActiveTargetOpens, activeTargetOpens);
        try {
          if (!heldFirstOpen) {
            heldFirstOpen = true;
            signalFirstOpen();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } finally {
          activeTargetOpens -= 1;
        }
      },
    });

    const firstWrite = scoped.write("state.txt", "first");
    await firstOpen;
    const secondWrite = scoped.write("state.txt", "second");
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([undefined, undefined]);
    expect(maxActiveTargetOpens).toBe(1);
    await expect(scoped.readText("state.txt")).resolves.toBe("second");
  });

  itPosix("rejects stable intermediate symlinks unless following is explicit", async () => {
    const rootDir = await tempRoot("fs-safe-intermediate-symlink-");
    await fs.mkdir(path.join(rootDir, "real"));
    await fs.writeFile(path.join(rootDir, "real", "value.txt"), "inside");
    await fs.symlink("real", path.join(rootDir, "alias"), "dir");
    const scoped = await openRoot(rootDir);

    await expectFsSafeError(scoped.readText("alias/value.txt"), "symlink");
    await expect(
      scoped.readText("alias/value.txt", { symlinks: "follow-within-root" }),
    ).resolves.toBe("inside");

    const syncStore = fileStoreSync({ rootDir });
    expectFsSafeErrorSync(() => syncStore.readTextIfExists("alias/value.txt"), "symlink");
  });

  itPosix("reports an intermediate symlink loop as a symlink failure when following", async () => {
    const rootDir = await tempRoot("fs-safe-symlink-loop-");
    await fs.symlink("loop-b", path.join(rootDir, "loop-a"), "dir");
    await fs.symlink("loop-a", path.join(rootDir, "loop-b"), "dir");
    const scoped = await openRoot(rootDir);

    await expectFsSafeError(scoped.readText("loop-a/value.txt", { symlinks: "follow-within-root" }), "symlink");
  });

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

    await expectFsSafeError(scoped.readText("target/value.txt"), "path-mismatch");
    await expect(fs.readFile(path.join(displacedDir, "value.txt"), "utf8")).resolves.toBe(
      "trusted",
    );
  });

  itPosix("rejects advisory access after the root pathname is replaced", async () => {
    const base = await tempRoot("fs-safe-root-identity-swap-");
    const rootDir = path.join(base, "root");
    const displacedRoot = path.join(base, "displaced-root");
    const outside = path.join(base, "outside");
    await fs.mkdir(rootDir);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(rootDir, "inside.txt"), "inside");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    const scoped = await openRoot(rootDir);

    await fs.rename(rootDir, displacedRoot);
    await fs.symlink(outside, rootDir, "dir");

    const operations: Array<[string, () => Promise<unknown>]> = [
      ["resolve", () => scoped.resolve("secret.txt")],
      ["open", () => scoped.open("secret.txt")],
      ["read", () => scoped.read("secret.txt")],
      ["readAbsolute", () => scoped.readAbsolute(path.join(rootDir, "secret.txt"))],
      ["write", () => scoped.write("written.txt", "blocked")],
      ["create", () => scoped.create("created.txt", "blocked")],
      ["append", () => scoped.append("secret.txt", "blocked")],
      ["openWritable", () => scoped.openWritable("written.txt")],
      [
        "copyIn",
        () => scoped.copyIn("copied.txt", path.join(displacedRoot, "inside.txt")),
      ],
      ["mkdir", () => scoped.mkdir("created")],
      ["remove", () => scoped.remove("secret.txt")],
      ["move", () => scoped.move("secret.txt", "moved.txt")],
      ["ensureRoot", () => scoped.ensureRoot()],
    ];
    for (const [label, operation] of operations) {
      await expect(operation(), label).rejects.toMatchObject({ code: "path-mismatch" });
    }
    await expectFsSafeError(scoped.stat("secret.txt"), "path-mismatch");
    await expectFsSafeError(scoped.list("."), "path-mismatch");
    await expectFsSafeError(scoped.exists("secret.txt"), "path-mismatch");
    await expect(async () => {
      for await (const _entry of scoped.walk(".", { symlinkPolicy: "skip" })) {
        // Consume the iterator: it must fail before yielding outside entries.
      }
    }).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe(
      "outside",
    );
    await expect(fs.readdir(outside)).resolves.toEqual(["secret.txt"]);
  });

  itPosix.each(["leaf", "parent"] as const)(
    "preserves a replacement %s when writable-open validation fails",
    async (swapKind) => {
      const rootDir = await tempRoot("fs-safe-writable-leaf-swap-");
      const scoped = await openRoot(rootDir);
      const parentPath = path.join(scoped.rootReal, "nested");
      await fs.mkdir(parentPath);
      const targetPath = path.join(parentPath, "created.txt");
      const displacedPath = path.join(scoped.rootReal, "created.displaced");
      const displacedParentPath = path.join(scoped.rootReal, "nested.displaced");
      const originalOpen = fs.open;
      let swapped = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (
          !swapped &&
          String(filePath) === targetPath &&
          typeof flags === "number" &&
          (flags & fsSync.constants.O_CREAT) !== 0
        ) {
          swapped = true;
          if (swapKind === "leaf") {
            await fs.rename(targetPath, displacedPath);
          } else {
            await fs.rename(parentPath, displacedParentPath);
            await fs.mkdir(parentPath);
          }
          const replacement = await originalOpen(targetPath, "wx");
          try {
            await replacement.writeFile("replacement");
          } finally {
            await replacement.close();
          }
        }
        return handle;
      });

      await expectFsSafeError(scoped.openWritable("nested/created.txt"), "path-mismatch");
      expect(swapped).toBe(true);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("replacement");
    },
  );

  itPosix("opens reads nonblocking so a raced FIFO is rejected without hanging", async () => {
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
  });

  it("does not canonicalize whitespace-padded FileStore keys onto another key", async () => {
    const rootDir = await tempRoot("fs-safe-store-whitespace-");
    const asyncStore = fileStore({ rootDir });
    const syncStore = fileStoreSync({ rootDir });
    await asyncStore.writeText("value.txt", "kept");

    for (const key of [" value.txt", "value.txt "]) {
      expectFsSafeErrorSync(() => asyncStore.path(key), "invalid-path");
      expectFsSafeErrorSync(() => syncStore.path(key), "invalid-path");
    }
    expect(fsSync.readFileSync(path.join(rootDir, "value.txt"), "utf8")).toBe("kept");
  });

  itPosix("classifies an OS-rejected overlong root path as invalid input rather than an escape", async () => {
    const rootDir = await tempRoot("fs-safe-overlong-path-");
    const scoped = await openRoot(rootDir);

    await expectFsSafeError(scoped.readText("x".repeat(10_000)), "invalid-path");
  });
});
