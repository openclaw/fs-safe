import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { assertSyncDirectoryGuard, createSyncDirectoryGuard } from "../src/directory-guard.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

it("retains exact identity behind rounded numeric directory metadata", async () => {
  const dir = await tempRoot("fs-safe-directory-precision-");
  const lstat = fs.lstatSync;
  let ino = 2n ** 54n;
  vi.spyOn(fs, "lstatSync").mockImplementation(((pathname: fs.PathLike, options?: { bigint?: boolean }) => {
    const stat = options?.bigint ? lstat(pathname, { bigint: true }) : lstat(pathname);
    return Object.assign(stat, { ino: options?.bigint ? ino : Number(ino) });
  }) as typeof fs.lstatSync);
  const guard = createSyncDirectoryGuard(dir);
  expect(guard.stat.ino).toBe(Number(ino));
  expect(() => assertSyncDirectoryGuard(guard)).not.toThrow();
  // Copying rounded metadata cannot carry the original guard's exact proof.
  expect(() => assertSyncDirectoryGuard({ ...guard })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  ino += 1n;
  expect(Number(ino)).toBe(guard.stat.ino);
  expect(() => assertSyncDirectoryGuard(guard)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
});
