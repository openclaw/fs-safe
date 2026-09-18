import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive, readArchiveEntry, resolveArchiveKind } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { readSecureFile } from "../src/secure-file.js";
import { compressedTarFraming } from "./helpers/archive-tar-framing-compressed.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "auto"] as const) {
  describe(`portable feature availability with mode ${mode}`, () => {
    function unavailable() {
      configureFsSafeNative({ mode });
      __setNativeLoaderForTest(() => { throw new Error("platform package omitted"); });
    }

    it.each(["tar-zstd", "tar-bzip2"] as const)("detects, extracts and reads %s without the addon", async (kind) => {
      unavailable();
      const root = await tempRoot("fs-safe-native-diagnostics-");
      const archivePath = path.join(root, kind === "tar-zstd" ? "fixture.tar.zst" : "fixture.tar.bz2");
      const destDir = path.join(root, "destination");
      await fs.mkdir(destDir);
      await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[0][kind], "base64"));
      expect(resolveArchiveKind(archivePath)).toBe(kind);
      await extractArchive({ archivePath, destDir, kind });
      expect(await fs.readFile(path.join(destDir, "value"), "utf8")).toBe("payload");
      expect(await readArchiveEntry(archivePath, "value", { maxBytes: 7, kind })).toEqual(Buffer.from("payload"));
      await expect(readArchiveEntry(archivePath, "value", { maxBytes: 6, kind })).rejects.toMatchObject({
        code: "archive-entry-extracted-size-exceeds-limit",
      });
    });

    it.each(["tar-zstd", "tar-bzip2"] as const)("still rejects malformed %s before publication", async (kind) => {
      unavailable();
      const root = await tempRoot("fs-safe-native-format-diagnostics-");
      const archivePath = path.join(root, "fixture");
      const destDir = path.join(root, "destination");
      await fs.mkdir(destDir);
      await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
      await fs.writeFile(archivePath, Buffer.from(compressedTarFraming[3][kind], "base64"));
      const expected = { code: "archive-header-invalid" };
      await expect(extractArchive({ archivePath, destDir, kind })).rejects.toMatchObject(expected);
      await expect(readArchiveEntry(archivePath, "value", { maxBytes: 7, kind })).rejects.toMatchObject(expected);
      expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
    });

    it.runIf(process.platform === "win32")("creates a private Windows directory and verifies real security facts", async () => {
      unavailable();
      const root = await tempRoot("fs-safe-windows-diagnostics-");
      const target = path.join(root, "private");
      await createPrivateDirectory(target);
      const facts = readOwnerAndDacl(target);
      expect(facts).toMatchObject({ status: "supported", complete: true, daclPresent: true, unsupportedAceTypes: [] });
      if (facts.status !== "supported") throw new Error("Windows ACL facts missing");
      expect(facts.ownerSid).toBe(facts.currentUserSid);
      const secret = path.join(target, "secret");
      await fs.writeFile(secret, "private bytes");
      expect((await readSecureFile({ filePath: secret })).buffer.toString()).toBe("private bytes");
      await expect(createPrivateDirectory(target)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await fs.readFile(secret, "utf8")).toBe("private bytes");
    }, 95_000);
  });
}

it("reports unsupported private-directory platforms without suggesting an install", async () => {
  await expect(createPrivateDirectory("unused", { platform: "linux" })).rejects.toMatchObject({
    code: "helper-unavailable",
    message: "private-directory creation is supported only on Windows",
  });
});
