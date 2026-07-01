import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafePython, root as openRoot } from "../src/index.js";
import { __resetPinnedPythonWorkerForTest } from "../src/pinned-python.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function replaceTargetAfterFallbackRename(replacement?: string): void {
  __setFsSafeTestHooksForTest({
    afterPinnedWriteFallbackRename: async (targetPath) => {
      const replacementPath = `${targetPath}.replacement`;
      const contents = replacement ?? await fsp.readFile(targetPath);
      await fsp.writeFile(replacementPath, contents);
      await fsp.rename(replacementPath, targetPath);
    },
  });
}

function compatibilityLockPath(rootDir: string, relativePath = "file.txt"): string {
  const digest = createHash("sha256").update(relativePath).digest("hex");
  return path.join(rootDir, `.fs-safe-write-${digest}.lock`);
}

afterEach(async () => {
  __setFsSafeTestHooksForTest();
  __resetPinnedPythonWorkerForTest();
  configureFsSafePython({ mode: "auto", pythonPath: undefined });
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("rename identity policy", () => {
  it.runIf(process.platform !== "win32")(
    "keeps strict post-rename identity verification as the default",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-strict-");
      replaceTargetAfterFallbackRename();

      const fs = await openRoot(rootDir);
      await expect(fs.write("file.txt", "hello")).rejects.toMatchObject({
        code: "path-mismatch",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts matching content under the explicit compatibility lock",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-lock-");
      const targetPath = path.join(rootDir, "file.txt");
      replaceTargetAfterFallbackRename();

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "hello")).resolves.toBeUndefined();
      await expect(fsp.readFile(targetPath, "utf8")).resolves.toBe("hello");
      await expect(fsp.stat(compatibilityLockPath(rootDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects replacement content despite the compatibility lock",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-attack-");
      replaceTargetAfterFallbackRename("attacker-content");

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "hello")).rejects.toMatchObject({
        code: "path-mismatch",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "supports a per-call compatibility override",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-per-call-");
      replaceTargetAfterFallbackRename();

      const fs = await openRoot(rootDir);
      await expect(
        fs.write("file.txt", "per-call", {
          renameIdentity: "verify-content-with-lock",
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "deliberately routes compatibility writes around required Python mode",
    async () => {
      configureFsSafePython({ mode: "require" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-python-");
      replaceTargetAfterFallbackRename();

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "hello")).resolves.toBeUndefined();
      await expect(fsp.readFile(path.join(rootDir, "file.txt"), "utf8")).resolves.toBe("hello");
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves already-exists errors for create",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-create-");
      await fsp.writeFile(path.join(rootDir, "file.txt"), "existing");

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.create("file.txt", "new")).rejects.toMatchObject({
        code: "already-exists",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not create a missing parent when mkdir is disabled",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-no-mkdir-");
      const parentPath = path.join(rootDir, "missing");

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("missing/file.txt", "hello", { mkdir: false })).rejects.toBeDefined();
      await expect(fsp.stat(parentPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed without deleting a stale sidecar lock",
    async () => {
      const rootDir = await makeTempRoot("fs-safe-rename-id-stale-");
      const lockPath = compatibilityLockPath(rootDir);
      await fsp.writeFile(
        lockPath,
        `${JSON.stringify({ pid: 9_999_999, createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
      );

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "hello")).rejects.toMatchObject({
        code: "file_lock_stale",
      });
      await expect(fsp.readFile(lockPath, "utf8")).resolves.toContain("9999999");
    },
  );

  it.runIf(process.platform !== "win32")(
    "works on a normal POSIX filesystem and releases the lock",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-posix-");

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "content")).resolves.toBeUndefined();
      await expect(fsp.readFile(path.join(rootDir, "file.txt"), "utf8")).resolves.toBe(
        "content",
      );
      await expect(fsp.stat(compatibilityLockPath(rootDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
