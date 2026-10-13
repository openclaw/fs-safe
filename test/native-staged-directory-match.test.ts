import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __loadBundledNativeForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Optional outside native CI. */ }
const { tempRoot } = useRealTempDirs();

describe.runIf(native?.stagedDirectoryMatches)("native staged directory matching", () => {
  it("accepts signed stat identities without admitting a different directory", async () => {
    const directory = await tempRoot("fs-safe-native-signed-identity-");
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const { dev, ino } = fs.fstatSync(fd, { bigint: true });
      expect(native!.stagedDirectoryMatches!(fd, directory, dev, ino)).toBe(true);
      for (const mismatched of [-1n, -(1n << 63n)]) {
        expect(native!.stagedDirectoryMatches!(fd, directory, dev, mismatched)).toBe(false);
      }
      for (const invalid of [-(1n << 63n) - 1n, 1n << 64n]) {
        expect(() => native!.stagedDirectoryMatches!(fd, directory, dev, invalid))
          .toThrow(expect.objectContaining({ code: "EINVAL" }));
      }
      expect(fs.fstatSync(fd, { bigint: true }).ino).toBe(ino);
    } finally { fs.closeSync(fd); }
  });

  it("rejects a replacement and a symlink while preserving the borrowed descriptor", async () => {
    const directory = await tempRoot("fs-safe-native-directory-match-");
    const target = path.join(directory, "parent");
    const held = path.join(directory, "held");
    await fsAsync.mkdir(target);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const identity = fs.fstatSync(fd, { bigint: true });
      const matches = (name: string) => native!.stagedDirectoryMatches!(fd, name, identity.dev, identity.ino);
      expect(matches(target)).toBe(true);
      fs.renameSync(target, held);
      fs.mkdirSync(target);
      expect(matches(target)).toBe(false);
      fs.rmdirSync(target);
      fs.symlinkSync(held, target, "dir");
      expect(matches(target)).toBe(false);
      expect(matches(held)).toBe(true);
      expect(fs.fstatSync(fd, { bigint: true }).ino).toBe(identity.ino);
    } finally { fs.closeSync(fd); }
  });
});
