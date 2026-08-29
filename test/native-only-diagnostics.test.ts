import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry, resolveArchiveKind } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const guidance = "install @openclaw/fs-safe with optional dependencies enabled on a supported platform " +
  "and use FS_SAFE_NATIVE_MODE=auto or require";

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "auto"] as const) {
  describe(`native-only diagnostics with mode ${mode}`, () => {
    function unavailable() {
      configureFsSafeNative({ mode });
      __setNativeLoaderForTest(() => { throw new Error("platform package omitted"); });
    }

    it.each(["tar-zstd", "tar-bzip2"] as const)("explains recovery for %s detection, extraction and reads", async (kind) => {
      unavailable();
      const root = await tempRoot("fs-safe-native-diagnostics-");
      const archivePath = path.join(root, kind === "tar-zstd" ? "fixture.tar.zst" : "fixture.tar.bz2");
      const destDir = path.join(root, "destination");
      await fs.writeFile(archivePath, "not compressed");
      const expected = {
        code: "helper-unavailable",
        message: `${kind} archives require the matching optional native platform package; ${guidance}`,
      };
      expect(() => resolveArchiveKind(archivePath)).toThrow(expect.objectContaining(expected));
      await expect(extractArchive({ archivePath, destDir, kind })).rejects.toMatchObject(expected);
      await expect(readArchiveEntry(archivePath, "value", { maxBytes: 5, kind })).rejects.toMatchObject(expected);
      await expect(fs.stat(destDir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("explains Windows recovery without creating a directory or returning ACL facts", async () => {
      unavailable();
      const root = await tempRoot("fs-safe-windows-diagnostics-");
      const target = path.join(root, "private");
      await expect(createPrivateDirectory(target, { platform: "win32" })).rejects.toMatchObject({
        code: "helper-unavailable",
        message: `private Windows directory creation requires the matching optional native platform package; ${guidance}`,
      });
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
      try {
        expect(() => readOwnerAndDacl(target)).toThrow(expect.objectContaining({
          code: "helper-unavailable",
          message: `Windows owner and DACL facts require the matching optional native platform package; ${guidance}`,
        }));
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    });
  });
}

it("reports unsupported private-directory platforms without suggesting an install", async () => {
  await expect(createPrivateDirectory("unused", { platform: "linux" })).rejects.toMatchObject({
    code: "helper-unavailable",
    message: "private-directory creation is supported only on Windows",
  });
});
