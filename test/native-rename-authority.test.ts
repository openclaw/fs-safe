import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";
import { NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH } from "../src/native-rename-outcome.js";
import { itWin32, useTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Native artifacts are exercised only by the dedicated platform jobs.
}

const { tempRoot } = useTempDirs();

describe.runIf(native)("native no-replace rename authority", () => {
  it("retains guarded traversal for deeper relative paths", async () => {
    const root = await tempRoot("fs-safe-native-deep-rename-");
    await fs.mkdir(path.join(root, "source-parent"));
    await fs.mkdir(path.join(root, "target-parent"));
    await fs.writeFile(path.join(root, "source-parent", "source"), "source");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      native!.renameNoReplace(
        rootFd,
        "source-parent/source",
        rootFd,
        "target-parent/target",
      );
    } finally {
      fsSync.closeSync(rootFd);
    }
    await expect(fs.lstat(path.join(root, "source-parent", "source")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(root, "target-parent", "target"), "utf8"))
      .resolves.toBe("source");
  });

  it("exposes identity-fenced direct-child rename without consuming caller descriptors", async () => {
    const root = await tempRoot("fs-safe-native-identity-rename-");
    const source = path.join(root, "source");
    await fs.mkdir(source);
    const expected = await fs.lstat(source, { bigint: true });
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      expect(native!.renameNoReplaceWithIdentity).toEqual(expect.any(Function));
      native!.renameNoReplaceWithIdentity!(
        rootFd,
        "source",
        rootFd,
        "target",
        expected.dev,
        expected.ino,
      );
      expect(fsSync.fstatSync(rootFd).isDirectory()).toBe(true);
    } finally {
      fsSync.closeSync(rootFd);
    }
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(path.join(root, "target"))).isDirectory()).toBe(true);
  });

  itWin32("rejects a changed source identity before mutation", async () => {
    const root = await tempRoot("fs-safe-native-rename-source-identity-");
    const source = path.join(root, "source");
    const original = path.join(root, "original");
    const target = path.join(root, "target");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "owned.txt"), "owned");
    const expected = await fs.lstat(source, { bigint: true });
    await fs.rename(source, original);
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "replacement.txt"), "replacement");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      expect(() => native!.renameNoReplaceWithIdentity!(
        rootFd,
        "source",
        rootFd,
        "target",
        expected.dev,
        expected.ino,
      )).toThrowError(expect.objectContaining({
        code: NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH,
      }));
    } finally {
      fsSync.closeSync(rootFd);
    }
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(source, "replacement.txt"), "utf8"))
      .resolves.toBe("replacement");
    await expect(fs.readFile(path.join(original, "owned.txt"), "utf8"))
      .resolves.toBe("owned");
  });
});
