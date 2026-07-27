import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __loadBundledNativeForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { inspectPathPermissions } from "../src/permissions.js";
import { createPrivateDirectory } from "../src/private-directory.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Ordinary JS jobs do not build a host binding.
}
const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-private-dir-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  await Promise.all(tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("createPrivateDirectory", () => {
  it.runIf(process.platform !== "win32")("fails closed without mutating POSIX paths", async () => {
    const root = await tempRoot();
    const target = path.join(root, "private");
    await expect(createPrivateDirectory(target)).rejects.toMatchObject({
      code: "helper-unavailable",
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when Windows native mode is off", async () => {
    const root = await tempRoot();
    const target = path.join(root, "fallback");
    configureFsSafeNative({ mode: "off" });
    await expect(createPrivateDirectory(target, { platform: "win32" })).rejects.toMatchObject({
      code: "helper-unavailable",
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32" && Boolean(native))(
    "creates and inspects the direct native DACL",
    async () => {
      const root = await tempRoot();
      const target = path.join(root, "native");
      __setNativeLoaderForTest(() => native!);
      configureFsSafeNative({ mode: "require" });
      await createPrivateDirectory(target);
      const facts = native!.readOwnerAndDacl(target);
      expect(facts.ownerClass).toBe("current-user");
      expect(facts.currentUserSid).toMatch(/^s-/);
      expect(facts.ownerSid).toBe(facts.currentUserSid);
      expect(facts).toMatchObject({
        worldWritable: false,
        groupWritable: false,
        fallbackRequired: false,
        daclPresent: true,
        isLocal: true,
        aceListComplete: true,
      });
      expect(facts.aces).toHaveLength(3);
      expect(facts.aces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            aceType: "allow",
            flags: expect.objectContaining({
              objectInherit: true,
              containerInherit: true,
              inheritOnly: false,
            }),
          }),
        ]),
      );
      await expect(inspectPathPermissions(target)).resolves.toMatchObject({
        source: "windows-acl",
        ownerTrusted: true,
        worldWritable: false,
        groupWritable: false,
      });
    },
  );
});
