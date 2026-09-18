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
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, executePermissionCommand } from "../src/permission-exec.js";
import { inspectPathPermissions, inspectWindowsAcl } from "../src/permissions.js";
import { createPrivateDirectory } from "../src/permissions-public.js";
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

  it("fails closed when Windows native mode requires a missing binding", async () => {
    const root = await tempRoot();
    const target = path.join(root, "fallback");
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => { throw new Error("optional native package omitted"); });
    await expectFsSafeError(
      createPrivateDirectory(target, { platform: "win32" }),
      "helper-unavailable",
    );
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32" && Boolean(native))(
    "rejects ambiguous components before creating any directory",
    async () => {
      const root = await tempRoot();
      __setNativeLoaderForTest(() => native!);
      configureFsSafeNative({ mode: "require" });
      for (const suffix of [
        "private.",
        "private ",
        "parent.\\private",
        "parent \\private",
        ".\\private",
        "parent\\..\\private",
      ]) {
        // Keep the spelling intact; path.join would remove dot components.
        await expect(createPrivateDirectory(root + "\\" + suffix)).rejects.toMatchObject({
          code: "EINVAL",
        });
        expect(await fs.readdir(root)).toEqual([]);
      }
    },
  );

  it.runIf(process.platform === "win32" && Boolean(native))(
    "preserves existing empty and populated directories",
    async () => {
      const root = await tempRoot();
      __setNativeLoaderForTest(() => native!);
      configureFsSafeNative({ mode: "require" });
      for (const populated of [false, true]) {
        const target = path.join(root, populated ? "populated" : "empty");
        await fs.mkdir(target);
        if (populated) await fs.writeFile(path.join(target, "keep"), "existing");
        const before = await fs.stat(target, { bigint: true });
        await expect(createPrivateDirectory(target)).rejects.toMatchObject({ code: "EEXIST" });
        const after = await fs.stat(target, { bigint: true });
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
        expect(await fs.readdir(target)).toEqual(populated ? ["keep"] : []);
        if (populated) {
          expect(await fs.readFile(path.join(target, "keep"), "utf8")).toBe("existing");
        }
      }
    },
  );

  it.runIf(process.platform === "win32" && Boolean(native))(
    "rejects an immediate parent junction without creating its child",
    async () => {
      const root = await tempRoot();
      const parent = path.join(root, "parent");
      const junction = path.join(root, "junction");
      await fs.mkdir(parent);
      await fs.symlink(parent, junction, "junction");
      __setNativeLoaderForTest(() => native!);
      configureFsSafeNative({ mode: "require" });
      await expect(createPrivateDirectory(path.join(junction, "private"))).rejects.toMatchObject({
        code: "ELOOP",
      });
      expect(await fs.readdir(parent)).toEqual([]);
      expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
    },
  );

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
      const inspections = [
        { role: "private-directory", pathname: target },
        { role: "inherited-file", pathname: file },
        { role: "junction", pathname: junction },
      ].map(({ role, pathname }) => ({
        role,
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
        const diagnostic = JSON.stringify({
          role: inspection.role,
          summary: { ok: summary.ok, error: summary.error, errorDetail: summary.errorDetail },
          fallback: { ok: fallback.ok, error: fallback.error, errorDetail: fallback.errorDetail },
        });
        expect(summary.ok, diagnostic).toBe(true);
        expect(fallback.ok, diagnostic).toBe(true);
        expect(summary, diagnostic).toEqual(fallback);
        if (inspection.pathname !== junction) {
          expect(summary.trusted).toHaveLength(3);
          expect(summary.untrustedWorld).toEqual([]);
          expect(summary.untrustedGroup).toEqual([]);
        }
      }
    },
    // The initial inspection and parallel comparisons each allow a bounded command phase.
    2 * DEFAULT_PERMISSION_EXEC_TIMEOUT_MS + 5000,
  );
});
