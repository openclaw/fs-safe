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
import { executePermissionCommand } from "../src/permission-exec.js";
import { inspectPathPermissions, inspectWindowsAcl } from "../src/permissions.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix } from "./helpers/vitest.js";

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
  await Promise.all(
    tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createPrivateDirectory", () => {
  itPosix("fails closed without mutating POSIX paths", async () => {
    const root = await tempRoot();
    const target = path.join(root, "private");
    await expectFsSafeError(createPrivateDirectory(target), "helper-unavailable");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when Windows native mode is off", async () => {
    const root = await tempRoot();
    const target = path.join(root, "fallback");
    configureFsSafeNative({ mode: "off" });
    await expectFsSafeError(
      createPrivateDirectory(target, { platform: "win32" }),
      "helper-unavailable",
    );
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
      const file = path.join(target, "ordinary-é-🦀.txt");
      await fs.writeFile(file, "ordinary ACL inspection");
      const junction = path.join(root, "ordinary-junction");
      await fs.symlink(target, junction, "junction");
      const readOwnerAndDacl = vi.fn(native!.readOwnerAndDacl);
      __setNativeLoaderForTest(() => ({ ...native!, readOwnerAndDacl }));
      const inspections = [target, file, junction].map((pathname) => ({
        pathname,
        summary: inspectWindowsAcl(pathname),
        fallback: inspectWindowsAcl(pathname, { exec: executePermissionCommand }),
      }));
      // These independent reads share one fixture. Join every process before
      // asserting so a failed read cannot race fixture cleanup.
      const settled = await Promise.allSettled(
        inspections.flatMap(({ summary, fallback }) => [summary, fallback]),
      );
      for (const result of settled) {
        if (result.status === "rejected") throw result.reason;
      }
      expect(readOwnerAndDacl.mock.calls.map(([pathname]) => pathname).sort()).toEqual(
        [target, file].sort(),
      );
      for (const inspection of inspections) {
        const summary = await inspection.summary;
        const fallback = await inspection.fallback;
        expect(summary.ok).toBe(true);
        expect(summary).toEqual(fallback);
        if (inspection.pathname !== junction) {
          expect(summary.trusted).toHaveLength(3);
          expect(summary.untrustedWorld).toEqual([]);
          expect(summary.untrustedGroup).toEqual([]);
        }
      }
    },
  );
});
