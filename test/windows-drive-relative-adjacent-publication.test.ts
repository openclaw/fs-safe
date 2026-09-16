import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonDurableQueueEntry } from "../src/json-durable-queue.js";
import { jsonStore } from "../src/json-store.js";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { getNativeBinding, type NativeBinding } from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { replaceDirectoryAtomic } from "../src/replace-directory.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

let directoryReplacementNative: NativeBinding | undefined;
try {
  const native = getNativeBinding();
  if (typeof native?.renameNoReplace === "function") {
    directoryReplacementNative = native;
  }
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

function driveRelativePath(absolutePath: string): string {
  const drive = path.parse(absolutePath).root.slice(0, 2);
  return `${drive}${path.relative(path.resolve(drive), absolutePath)}`;
}

function malformedNamespaceDrive(absolutePath: string): string {
  const drive = path.parse(absolutePath).root.slice(0, 2);
  return `\\\\?\\${drive}`;
}

const aliasError = {
  code: "invalid-path",
  details: { reason: "windows-path-alias" },
};

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});

describe.runIf(process.platform === "win32")(
  "Windows drive-relative adjacent publication boundaries",
  () => {
    it("keeps jsonStore bound to the actual drive-relative file", async () => {
      const root = await tempRoot("fs-safe-drive-json-store-");
      const filePath = path.join(root, "state.json");
      const store = jsonStore<{ value: number }>({
        filePath: driveRelativePath(filePath),
      });

      expect(store.filePath).toBe(filePath);
      await store.write({ value: 7 });

      await expect(store.readRequired()).resolves.toEqual({ value: 7 });
      await expect(fs.readFile(filePath, "utf8")).resolves.toContain('"value": 7');
    });

    it("carries a drive-relative durable queue path through publication and sync", async () => {
      const root = await tempRoot("fs-safe-drive-queue-write-");
      const filePath = path.join(root, "job.json");

      await writeJsonDurableQueueEntry({
        filePath: driveRelativePath(filePath),
        entry: { queued: true },
        tempPrefix: "queue",
      });

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
        '{\n  "queued": true\n}',
      );
      await expect(fs.readdir(root)).resolves.toEqual(["job.json"]);
    });

    it.each(["staged", "target", "both"] as const)(
      "replaces the intended directories with %s drive-relative operands",
      async (relativeOperand) => {
        const root = await tempRoot("fs-safe-drive-directory-replace-");
        const stagedDir = path.join(root, "staged");
        const targetDir = path.join(root, "target");
        await fs.mkdir(stagedDir);
        await fs.writeFile(path.join(stagedDir, "new.txt"), "new");

        const replacement = replaceDirectoryAtomic({
          stagedDir: relativeOperand === "target"
            ? stagedDir
            : driveRelativePath(stagedDir),
          targetDir: relativeOperand === "staged"
            ? targetDir
            : driveRelativePath(targetDir),
        });

        if (!directoryReplacementNative) {
          await expect(replacement).rejects.toMatchObject({ code: "helper-unavailable" });
          await expect(fs.access(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.readFile(path.join(stagedDir, "new.txt"), "utf8"))
            .resolves.toBe("new");
          return;
        }

        await expect(replacement).resolves.toBeUndefined();
        await expect(fs.readFile(path.join(targetDir, "new.txt"), "utf8")).resolves.toBe("new");
        await expect(fs.access(stagedDir)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it.each(["source", "target", "both"] as const)(
      "reports the anchored destination with %s drive-relative move operands",
      async (relativeOperand) => {
        const root = await tempRoot("fs-safe-drive-move-");
        const sourcePath = path.join(root, "source.txt");
        const targetPath = path.join(root, "target.txt");
        await fs.writeFile(sourcePath, "moved");
        let receipt: { path: string; dev: bigint; ino: bigint } | undefined;

        await movePathWithCopyFallback({
          from: relativeOperand === "target"
            ? sourcePath
            : driveRelativePath(sourcePath),
          to: relativeOperand === "source"
            ? targetPath
            : driveRelativePath(targetPath),
          onDestinationPublished: (value) => {
            receipt = value;
          },
        });

        expect(receipt).toMatchObject({ path: targetPath });
        expect(Object.isFrozen(receipt)).toBe(true);
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("moved");
        await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it.each(["source", "target", "both"] as const)(
      "uses anchored %s spellings throughout exclusive publication",
      async (relativeOperand) => {
        const root = await tempRoot("fs-safe-drive-publish-");
        const sourcePath = path.join(root, "source.txt");
        const targetPath = path.join(root, "target.txt");
        await fs.writeFile(sourcePath, "published");
        const observedTargets: string[] = [];
        __setFsSafeTestHooksForTest({
          afterPublishTargetCreated(_method, createdPath) {
            observedTargets.push(createdPath);
          },
        });

        await publishFileExclusive({
          sourcePath: relativeOperand === "target"
            ? sourcePath
            : driveRelativePath(sourcePath),
          targetPath: relativeOperand === "source"
            ? targetPath
            : driveRelativePath(targetPath),
          strategy: "link-or-copy",
        });

        expect(observedTargets).toEqual([targetPath]);
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("published");
      },
    );

    it("continues to accept current-drive-rooted source and target paths", async () => {
      const currentRoot = path.parse(process.cwd()).root;
      const root = await fs.mkdtemp(
        path.join(process.cwd(), ".fs-safe-root-relative-publish-"),
      );
      try {
        const sourcePath = path.join(root, "source.txt");
        const targetPath = path.join(root, "target.txt");
        await fs.writeFile(sourcePath, "root-relative");

        await publishFileExclusive({
          sourcePath: sourcePath.slice(currentRoot.length - 1),
          targetPath: targetPath.slice(currentRoot.length - 1),
          strategy: "link-or-copy",
        });

        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("root-relative");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it.each([
      "drive-relative ADS",
      "traversed drive-relative ADS",
      "bare namespace drive",
    ] as const)(
      "rejects %s before any adjacent publication authority",
      async (kind) => {
        const root = await tempRoot("fs-safe-drive-publication-reject-");
        const targetPath = path.join(root, "blocked");
        const alias = kind === "drive-relative ADS"
          ? `${driveRelativePath(targetPath)}:hidden`
          : kind === "traversed drive-relative ADS"
            ? `${driveRelativePath(root)}${path.sep}shadow:stream${path.sep}..${path.sep}blocked`
            : malformedNamespaceDrive(targetPath);
        const missingSource = path.join(root, "missing-source");
        const missingStaged = path.join(root, "missing-staged");
        const missingTarget = path.join(root, "missing-target");

        expect(() => jsonStore({ filePath: alias })).toThrow(expect.objectContaining(aliasError));
        await expect(writeJsonDurableQueueEntry({
          filePath: alias,
          entry: { blocked: false },
          tempPrefix: "queue",
        })).rejects.toMatchObject(aliasError);
        await expect(replaceDirectoryAtomic({
          stagedDir: driveRelativePath(missingStaged),
          targetDir: alias,
        })).rejects.toMatchObject(aliasError);
        await expect(replaceDirectoryAtomic({
          stagedDir: alias,
          targetDir: driveRelativePath(missingTarget),
        })).rejects.toMatchObject(aliasError);
        await expect(movePathWithCopyFallback({
          from: driveRelativePath(missingSource),
          to: alias,
        })).rejects.toMatchObject(aliasError);
        await expect(movePathWithCopyFallback({
          from: alias,
          to: driveRelativePath(missingTarget),
        })).rejects.toMatchObject(aliasError);
        await expect(publishFileExclusive({
          sourcePath: driveRelativePath(missingSource),
          targetPath: alias,
          strategy: "link-or-copy",
        })).rejects.toMatchObject(aliasError);
        await expect(publishFileExclusive({
          sourcePath: alias,
          targetPath: driveRelativePath(missingTarget),
          strategy: "link-or-copy",
        })).rejects.toMatchObject(aliasError);

        await expect(fs.readdir(root)).resolves.toEqual([]);
      },
    );

    it("keeps handmade drive-relative parent receipts fail-closed", async () => {
      const root = await tempRoot("fs-safe-drive-parent-receipt-");
      const sourcePath = path.join(root, "source.txt");
      const targetPath = path.join(root, "target.txt");
      await fs.writeFile(sourcePath, "source");

      await expect(publishFileExclusive({
        sourcePath: driveRelativePath(sourcePath),
        targetPath: driveRelativePath(targetPath),
        strategy: "link-or-copy",
        parentReceipt: {
          path: driveRelativePath(root),
          realPath: await fs.realpath(root),
          identity: fsSync.statSync(root),
        },
      })).rejects.toMatchObject(aliasError);

      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("source");
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
