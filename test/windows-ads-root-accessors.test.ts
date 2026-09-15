import fsSync from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveRootPath, resolveRootPathSync } from "../src/root-path.js";
import { openLocalFileSafely } from "../src/root.js";
import {
  ensureDirectoryWithinRoot,
  resolveExistingPathsWithinRoot,
  resolvePathWithinRoot,
  resolvePathsWithinRoot,
  resolveWritablePathWithinRoot,
} from "../src/root-paths.js";

function once<T>(value: T): { get(): T; reads(): number } {
  let count = 0;
  return {
    get() {
      count += 1;
      if (count > 1) throw new Error("pathname getter read more than once");
      return value;
    },
    reads: () => count,
  };
}

describe("owned root pathname inputs", () => {
  it("retains the admitted local-file pathname through open", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-local-open-accessor-"));
    const filePath = path.join(rootDir, "payload.txt");
    const aliasedPath = `${filePath}:hidden`;
    await writeFile(filePath, "first");
    let reads = 0;
    let opened: Awaited<ReturnType<typeof openLocalFileSafely>> | undefined;
    try {
      opened = await openLocalFileSafely({
        get filePath() {
          reads += 1;
          return reads === 1 ? filePath : aliasedPath;
        },
      });
      expect(reads).toBe(1);
      await expect(opened.handle.readFile("utf8")).resolves.toBe("first");
    } finally {
      await opened?.handle.close().catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("captures direct root-resolution pathname getters once", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-root-accessor-"));
    try {
      for (const resolve of [resolveRootPath, resolveRootPathSync] as const) {
        const rootPath = once(rootDir);
        const absolutePath = once(path.join(rootDir, "missing.txt"));
        const rootCanonicalPath = once(rootDir);
        const params = {
          get rootPath() { return rootPath.get(); },
          get absolutePath() { return absolutePath.get(); },
          get rootCanonicalPath() { return rootCanonicalPath.get(); },
          boundaryLabel: "workspace",
        } as Parameters<typeof resolveRootPath>[0];

        await resolve(params);
        expect([rootPath.reads(), absolutePath.reads(), rootCanonicalPath.reads()])
          .toEqual([1, 1, 1]);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("retains owned lexical and asynchronous path-scope inputs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-scope-accessor-"));
    try {
      const lexicalRoot = once(rootDir);
      const lexicalPath = once("child.txt");
      const lexicalDefault = once("default.txt");
      expect(resolvePathWithinRoot({
        get rootDir() { return lexicalRoot.get(); },
        get requestedPath() { return lexicalPath.get(); },
        get defaultFileName() { return lexicalDefault.get(); },
        scopeLabel: "workspace",
      })).toMatchObject({ ok: true });
      expect([lexicalRoot.reads(), lexicalPath.reads(), lexicalDefault.reads()])
        .toEqual([1, 1, 1]);

      const writableRoot = once(rootDir);
      const writablePath = once("pending.txt");
      const writableDefault = once("default.txt");
      await expect(resolveWritablePathWithinRoot({
        get rootDir() { return writableRoot.get(); },
        get requestedPath() { return writablePath.get(); },
        get defaultFileName() { return writableDefault.get(); },
        scopeLabel: "workspace",
      })).resolves.toMatchObject({ ok: true });
      expect([writableRoot.reads(), writablePath.reads(), writableDefault.reads()])
        .toEqual([1, 1, 1]);

      const existingRoot = once(rootDir);
      const requestedPaths = once(["missing.txt"]);
      await expect(resolveExistingPathsWithinRoot({
        get rootDir() { return existingRoot.get(); },
        get requestedPaths() { return requestedPaths.get(); },
        scopeLabel: "workspace",
      })).resolves.toMatchObject({ ok: true });
      expect([existingRoot.reads(), requestedPaths.reads()]).toEqual([1, 1]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("owns path collections and directory-creation inputs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-path-list-accessor-"));
    try {
      let rootReads = 0;
      const list = once(["one.txt", "two.txt"]);
      expect(resolvePathsWithinRoot({
        get rootDir() {
          rootReads += 1;
          return rootDir;
        },
        get requestedPaths() { return list.get(); },
        scopeLabel: "workspace",
      })).toMatchObject({ ok: true });
      expect([rootReads, list.reads()]).toEqual([2, 1]);

      const directoryRoot = once(rootDir);
      const directoryPath = once("nested");
      await expect(ensureDirectoryWithinRoot({
        get rootDir() { return directoryRoot.get(); },
        get requestedPath() { return directoryPath.get(); },
        scopeLabel: "workspace",
      })).resolves.toMatchObject({ ok: true });
      expect([directoryRoot.reads(), directoryPath.reads()]).toEqual([1, 1]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "treats a canonical namespace alias as invalid instead of missing",
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-root-real-alias-"));
      const realpath = vi.spyOn(fsSync.realpathSync, "native")
        .mockReturnValue(`${rootDir}:payload`);
      try {
        await expect(resolveExistingPathsWithinRoot({
          rootDir,
          requestedPaths: ["missing.txt"],
          scopeLabel: "workspace",
        })).resolves.toEqual({
          ok: false,
          error: "Invalid path: must stay within workspace",
        });
      } finally {
        realpath.mockRestore();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
