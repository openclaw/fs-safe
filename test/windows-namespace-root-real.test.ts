import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createNearestExistingDirectoryGuard,
  createSyncDirectoryGuard,
  inspectDirectoryIdentity,
} from "../src/directory-guard.js";
import { executePermissionCommand } from "../src/permission-exec.js";
import {
  inspectPathPermissions,
  safeStat,
} from "../src/permissions.js";
import { inspectWindowsAcl } from "../src/permissions-windows.js";
import { root } from "../src/root.js";
import { resolveRootContext } from "../src/root-context.js";
import { resolveRootPath, resolveRootPathSync } from "../src/root-path.js";

function expectSameRealPath(actual: string, expected: string): void {
  expect(fsSync.realpathSync.native(actual).toLowerCase())
    .toBe(fsSync.realpathSync.native(expected).toLowerCase());
}

describe.skipIf(process.platform !== "win32")("real Windows namespace drive roots", () => {
  it.each(["?", "."] as const)(
    "dispatches the %s namespace root without losing lexical identity",
    async (namespace) => {
      const driveRoot = path.parse(process.cwd()).root;
      expect(driveRoot).toMatch(/^[A-Za-z]:\\$/u);
      const namespaceRoot = `\\\\${namespace}\\${driveRoot}`;
      const canonicalRoot = fsSync.realpathSync.native(driveRoot);
      const relativeCwd = path.relative(driveRoot, process.cwd());
      const namespaceCwd = path.join(namespaceRoot, relativeCwd);
      const missingName = `.fs-safe-namespace-missing-${process.pid}-${Date.now()}`;
      const namespaceMissing = path.join(namespaceRoot, missingName);
      const canonicalMissing = path.join(canonicalRoot, missingName);
      expect(fsSync.existsSync(canonicalMissing)).toBe(false);
      await expect(inspectDirectoryIdentity(namespaceRoot)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
      await expect(createNearestExistingDirectoryGuard(namespaceRoot, namespaceMissing))
        .resolves.toMatchObject({ dir: namespaceRoot });
      const syncGuard = createSyncDirectoryGuard(namespaceRoot);
      expect(syncGuard.dir).toBe(namespaceRoot);
      expect(syncGuard.stat.isDirectory()).toBe(true);
      expectSameRealPath(syncGuard.realPath, driveRoot);
      await expect(safeStat(namespaceRoot)).resolves.toMatchObject({
        ok: true,
        isDir: true,
        isSymlink: false,
      });
      await expect(inspectPathPermissions(namespaceRoot)).resolves.toMatchObject({
        ok: true,
        isDir: true,
        isSymlink: false,
        source: "windows-acl",
      });
      const acl = await inspectWindowsAcl(namespaceRoot);
      const fallbackAcl = await inspectWindowsAcl(namespaceRoot, {
        exec: executePermissionCommand,
      });
      expect(acl).toEqual(fallbackAcl);
      expect(acl.ok).toBe(true);

      const suppliedCanonicalParams = {
        rootPath: namespaceRoot,
        absolutePath: namespaceRoot,
        rootCanonicalPath: namespaceRoot,
        boundaryLabel: "namespace root",
      };
      const suppliedCanonicalExpected = {
        absolutePath: namespaceRoot,
        canonicalPath: namespaceRoot,
        rootPath: namespaceRoot,
        rootCanonicalPath: namespaceRoot,
        relativePath: "",
        exists: true,
        kind: "directory",
      };
      await expect(resolveRootPath(suppliedCanonicalParams)).resolves
        .toEqual(suppliedCanonicalExpected);
      expect(resolveRootPathSync(suppliedCanonicalParams))
        .toEqual(suppliedCanonicalExpected);

      for (const rootInput of [namespaceRoot, `${namespaceRoot}.`]) {
        const params = {
          rootPath: rootInput,
          absolutePath: rootInput,
          boundaryLabel: "namespace root",
        };
        const expected = {
          absolutePath: namespaceRoot,
          canonicalPath: canonicalRoot,
          rootPath: namespaceRoot,
          rootCanonicalPath: canonicalRoot,
          relativePath: "",
          exists: true,
          kind: "directory",
        };
        await expect(resolveRootPath(params)).resolves.toEqual(expected);
        expect(resolveRootPathSync(params)).toEqual(expected);
      }

      const existingParams = {
        rootPath: namespaceRoot,
        absolutePath: namespaceCwd,
        boundaryLabel: "namespace root",
      };
      const existing = await resolveRootPath(existingParams);
      expect(resolveRootPathSync(existingParams)).toEqual(existing);
      expect(existing).toMatchObject({
        absolutePath: namespaceCwd,
        rootPath: namespaceRoot,
        rootCanonicalPath: canonicalRoot,
        exists: true,
        kind: "directory",
      });
      expectSameRealPath(existing.canonicalPath, process.cwd());

      const missingParams = {
        rootPath: namespaceRoot,
        absolutePath: namespaceMissing,
        boundaryLabel: "namespace root",
      };
      const missing = await resolveRootPath(missingParams);
      expect(resolveRootPathSync(missingParams)).toEqual(missing);
      expect(missing).toEqual({
        absolutePath: namespaceMissing,
        canonicalPath: canonicalMissing,
        rootPath: namespaceRoot,
        rootCanonicalPath: canonicalRoot,
        relativePath: missingName,
        exists: false,
        kind: "missing",
      });

      for (const rootInput of [namespaceRoot, `${namespaceRoot}.`]) {
        await expect(resolveRootContext(rootInput)).resolves.toMatchObject({
          rootDir: namespaceRoot,
          rootReal: canonicalRoot,
          rootWithSep: canonicalRoot,
        });
        const mutationAuthority = vi.fn(() => {
          throw new Error("mutation authority must not run for invalid paths");
        });
        const scoped = await root(rootInput, { assertBeforeMutation: mutationAuthority });
        const resolvedRoot = await scoped.resolve(".");
        expectSameRealPath(resolvedRoot, driveRoot);
        const resolvedCwd = await scoped.resolve(relativeCwd.split(path.sep).join("/"));
        expectSameRealPath(resolvedCwd, process.cwd());
        expect(await scoped.resolve(missingName)).toBe(canonicalMissing);
        const entries = scoped.entries(relativeCwd.split(path.sep).join("/"), {
          maxEntries: 1,
          order: "filesystem",
        });
        expect((await entries.next()).done).toBe(false);
        await entries.return?.();

        for (const operation of [
          () => scoped.write("C:relative", "blocked"),
          () => scoped.write("child:stream", "blocked"),
          () => scoped.mkdir("child::$INDEX_ALLOCATION"),
        ]) {
          await expect(operation()).rejects.toMatchObject({
            code: "invalid-path",
            details: { reason: "windows-path-alias" },
          });
        }
        expect(mutationAuthority).not.toHaveBeenCalled();

        const rmdir = vi.spyOn(fs, "rmdir")
          .mockRejectedValue(new Error("root removal must not dispatch"));
        const unlink = vi.spyOn(fs, "unlink")
          .mockRejectedValue(new Error("root removal must not dispatch"));
        try {
          await expect(scoped.remove(".")).rejects.toMatchObject({
            code: "outside-workspace",
          });
          expect(rmdir).not.toHaveBeenCalled();
          expect(unlink).not.toHaveBeenCalled();
        } finally {
          rmdir.mockRestore();
          unlink.mockRestore();
        }
      }
    },
  );
});
