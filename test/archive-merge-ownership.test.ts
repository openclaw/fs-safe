import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeExtractedTreeIntoDestination } from "../src/archive.js";
import { withExtractionDeadline } from "../src/archive-deadline.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  __resetFsSafeNativeConfigForTest();
});

async function fixture() {
  const base = await tempRoot("fs-safe-archive-ownership-");
  const sourceDir = path.join(base, "source");
  const destinationDir = path.join(base, "destination");
  await fs.mkdir(sourceDir);
  await fs.mkdir(destinationDir);
  const source = path.join(sourceDir, "keep");
  const target = path.join(destinationDir, "keep");
  await fs.writeFile(source, "NEW");
  await fs.writeFile(target, "OLD");
  return {
    base, source, target,
    params: { sourceDir, destinationDir, destinationRealDir: destinationDir },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("archive merge cleanup ownership", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "preserves OLD when a real write-only source fails to open before publication",
    async () => {
      const { source, target, params } = await fixture();
      const original = await fs.stat(target, { bigint: true });
      await fs.chmod(source, 0o200);

      try {
        await expect(fs.readFile(source)).rejects.toMatchObject({ code: "EACCES" });
        await expect(mergeExtractedTreeIntoDestination(params)).rejects.toMatchObject({
          code: "EACCES",
        });
        await expect(fs.readFile(target, "utf8")).resolves.toBe("OLD");
        await expect(fs.stat(target, { bigint: true })).resolves.toMatchObject({
          dev: original.dev, ino: original.ino,
        });
        await expect(fs.readdir(params.destinationDir)).resolves.toEqual(["keep"]);
      } finally {
        await fs.chmod(source, 0o600);
      }
    },
  );

  it("successfully replaces OLD with NEW and merges nested entries", async () => {
    const { source, target, params } = await fixture();
    await fs.mkdir(path.join(params.sourceDir, "nested"));
    await fs.writeFile(path.join(params.sourceDir, "nested", "entry"), "NESTED");
    if (process.platform !== "win32") await fs.chmod(source, 0o640);

    await mergeExtractedTreeIntoDestination(params);

    await expect(fs.readFile(target, "utf8")).resolves.toBe("NEW");
    await expect(fs.readFile(path.join(params.destinationDir, "nested", "entry"), "utf8"))
      .resolves.toBe("NESTED");
    if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "retains a completed entry when the next source cannot be opened",
    async () => {
      configureFsSafeNative({ mode: "off" });
      const { params } = await fixture();
      await fs.writeFile(path.join(params.sourceDir, "other"), "NEW");
      await fs.writeFile(path.join(params.destinationDir, "other"), "OLD");
      let completed = "";
      let unreadable = "";
      __setFsSafeTestHooksForTest({
        async afterPinnedWriteFallbackRename(targetPath) {
          if (completed) return;
          completed = path.basename(targetPath);
          unreadable = completed === "keep" ? "other" : "keep";
          await fs.chmod(path.join(params.sourceDir, unreadable), 0o200);
        },
      });

      try {
        await expect(mergeExtractedTreeIntoDestination(params)).rejects.toMatchObject({
          code: "EACCES",
        });
        expect(completed).not.toBe("");
        await expect(fs.readFile(path.join(params.destinationDir, completed), "utf8"))
          .resolves.toBe("NEW");
        await expect(fs.readFile(path.join(params.destinationDir, unreadable), "utf8"))
          .resolves.toBe("OLD");
      } finally {
        if (unreadable) await fs.chmod(path.join(params.sourceDir, unreadable), 0o600);
      }
    },
  );

  itPosix.each(["file", "hardlink", "symlink"] as const)(
    "preserves a substituted %s when copyIn rejects its post-rename identity check",
    async (replacement) => {
      configureFsSafeNative({ mode: "off" });
      const { base, target, params } = await fixture();
      const substitute = path.join(base, "substitute");
      const published = path.join(base, "published");
      await fs.writeFile(substitute, "SUBSTITUTE", { mode: 0o600 });
      let replaced = false;
      __setFsSafeTestHooksForTest({
        async afterPinnedWriteFallbackRename(targetPath) {
          if (targetPath !== target) return;
          await fs.rename(target, published);
          if (replacement === "file") await fs.rename(substitute, target);
          else if (replacement === "hardlink") await fs.link(substitute, target);
          else await fs.symlink(substitute, target);
          replaced = true;
        },
      });

      await expect(mergeExtractedTreeIntoDestination(params)).rejects.toMatchObject({
        code: "path-mismatch",
      });

      expect(replaced).toBe(true);
      await expect(fs.readFile(target, "utf8")).resolves.toBe("SUBSTITUTE");
      await expect(fs.readFile(published, "utf8")).resolves.toBe("NEW");
      if (replacement !== "file") {
        await expect(fs.readFile(substitute, "utf8")).resolves.toBe("SUBSTITUTE");
      }
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(replacement === "symlink");
      if (replacement === "hardlink") expect((await fs.stat(target)).nlink).toBe(2);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    },
  );

  itPosix("rejects a post-publication hardlink without unlinking either alias", async () => {
    configureFsSafeNative({ mode: "off" });
    const { base, target, params } = await fixture();
    const alias = path.join(base, "alias");
    __setFsSafeTestHooksForTest({
      async afterPinnedWriteFallbackRename(targetPath) {
        if (targetPath === target) await fs.link(target, alias);
      },
    });

    await expect(mergeExtractedTreeIntoDestination(params)).rejects.toMatchObject({
      code: "destination-symlink-traversal",
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("NEW");
    await expect(fs.readFile(alias, "utf8")).resolves.toBe("NEW");
    expect((await fs.stat(target)).nlink).toBe(2);
  });

  itPosix("leaves receipt-based source-swap cleanup to copyIn", async () => {
    configureFsSafeNative({ mode: "off" });
    const { base, source, target, params } = await fixture();
    __setFsSafeTestHooksForTest({
      async afterPinnedWriteFallbackRename(targetPath) {
        if (targetPath !== target) return;
        await fs.rename(source, path.join(base, "original-source"));
        await fs.writeFile(source, "REPLACED SOURCE");
      },
    });

    await expect(mergeExtractedTreeIntoDestination(params)).rejects.toMatchObject({
      code: "path-mismatch",
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(source, "utf8")).resolves.toBe("REPLACED SOURCE");
  });

  itPosix.each(["published", "file", "hardlink", "symlink"] as const)(
    "joins post-copy timeout, preserves %s, and starts no later mutations",
    async (replacement) => {
      configureFsSafeNative({ mode: "off" });
      const { base, target, params } = await fixture();
      const substitute = path.join(base, "substitute");
      await fs.writeFile(substitute, "SUBSTITUTE", { mode: 0o600 });
      await fs.writeFile(path.join(params.sourceDir, "later"), "LATER");
      const entered = deferred();
      const expired = deferred();
      const release = deferred();
      const mutations: string[] = [];
      __setFsSafeTestHooksForTest({
        async afterPinnedWriteFallbackRename(targetPath) {
          mutations.push(`publish:${targetPath}`);
          if (targetPath !== target) return;
          await expect(fs.readFile(target, "utf8")).resolves.toBe("NEW");
          if (replacement !== "published") {
            await fs.rename(target, path.join(base, "published"));
            if (replacement === "file") await fs.rename(substitute, target);
            else if (replacement === "hardlink") await fs.link(substitute, target);
            else await fs.symlink(substitute, target);
          }
          entered.resolve();
          await release.promise;
        },
      });
      let settled = false;
      const merge = withExtractionDeadline(1_000, "merge", async (deadline) => {
        deadline.signal.addEventListener("abort", expired.resolve, { once: true });
        await mergeExtractedTreeIntoDestination({ ...params, deadline });
      });
      void merge.then(() => { settled = true; }, () => { settled = true; });

      try {
        await entered.promise;
        await expired.promise;
        expect(settled).toBe(false);
      } finally {
        release.resolve();
      }
      await expect(merge).rejects.toThrow("merge timed out after 1000ms");
      const expected = replacement === "published" ? "NEW" : "SUBSTITUTE";
      await expect(fs.readFile(target, "utf8")).resolves.toBe(expected);
      await expect(fs.readdir(params.destinationDir)).resolves.toEqual(["keep"]);
      if (replacement === "hardlink" || replacement === "symlink") {
        await expect(fs.readFile(substitute, "utf8")).resolves.toBe("SUBSTITUTE");
      }
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(replacement === "symlink");
      if (replacement === "hardlink") expect((await fs.stat(target)).nlink).toBe(2);
      if (replacement !== "published") expect((await fs.stat(target)).mode & 0o777).toBe(0o600);

      const mutationsAtRejection = [...mutations];
      await fs.writeFile(target, "RECOVERY");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mutations).toEqual(mutationsAtRejection);
      await expect(fs.readFile(target, "utf8")).resolves.toBe("RECOVERY");
      await expect(fs.readdir(params.destinationDir)).resolves.toEqual(["keep"]);
    },
  );
});
