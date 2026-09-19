import fsSync from "node:fs";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinDirectory, syncDirectorySync } from "../src/directory-durability.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("directory receipt metadata provenance", () => {
  it("normalizes caller bigint metadata without changing the exact admission", async () => {
    const directory = await tempRoot("fs-safe-directory-bigint-metadata-");
    const identity = await fs.lstat(directory, { bigint: true });
    const before = await fs.lstat(directory);
    const supplied = { path: directory, realPath: directory, identity };
    const outcome = syncDirectorySync(supplied);
    expect(process.platform === "win32" ? ["synced", "unsupported"] : ["synced"]).toContain(outcome.status);
    const pending = pinDirectory(supplied);
    identity.mode ^= 0o777n;
    identity.mtimeNs = 1n;
    const pinned = await pending;
    try {
      const exposed = pinned.receipt.identity;
      expect(exposed).toBeInstanceOf(fsSync.Stats);
      expect(exposed.isDirectory()).toBe(true);
      expect(exposed.isFile()).toBe(false);
      expect(exposed).toMatchObject(before);
      for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
        expect(typeof exposed[`${field}Ms`]).toBe("number");
        expect(exposed[field]).toEqual(before[field]);
      }
      await expect(pinned.assertCurrent()).resolves.toBeUndefined();
      const readmitted = await pinDirectory(pinned.receipt);
      try {
        expect(readmitted.receipt.identity).toMatchObject(before);
        expect(readmitted.receipt.identity.isDirectory()).toBe(true);
      } finally {
        await readmitted.close();
      }
    } finally {
      await pinned.close();
    }
  });

  it.each(["receipt", "identity wrapper"] as const)(
    "retains admitted metadata when reusing a mutated library %s",
    async kind => {
      const directory = await tempRoot("fs-safe-directory-metadata-");
      const original = await pinDirectory(directory);
      const independent = await pinDirectory(original.receipt);
      const initial = { ...original.receipt.identity };
      const exposed = original.receipt.identity;
      const initialDates = {
        atime: new Date(exposed.atime.getTime()),
        mtime: new Date(exposed.mtime.getTime()),
        ctime: new Date(exposed.ctime.getTime()),
        birthtime: new Date(exposed.birthtime.getTime()),
      };
      try {
        expect(independent.receipt.identity).not.toBe(exposed);
        expect(Object.isFrozen(exposed)).toBe(false);
        exposed.mode ^= 0o777;
        exposed.uid += 1;
        exposed.gid += 1;
        exposed.nlink += 1;
        exposed.size += 1024;
        exposed.mtimeMs += 86_400_000;
        exposed.ctimeMs -= 1000;
        exposed.atime.setUTCFullYear(2000);
        expect(exposed.mode).not.toBe(initial.mode);
        await expect(original.assertCurrent()).resolves.toBeUndefined();
        expect(independent.receipt.identity).toMatchObject(initial);
        expect(independent.receipt.identity.atime).toEqual(initialDates.atime);

        const supplied = kind === "receipt" ? original.receipt : {
          path: original.receipt.path,
          realPath: original.receipt.realPath,
          identity: exposed,
        };
        const readmitted = await pinDirectory(supplied);
        try {
          expect(readmitted.receipt.identity).toBeInstanceOf(fsSync.Stats);
          expect(readmitted.receipt.identity).not.toBe(exposed);
          expect(readmitted.receipt.identity).not.toBe(independent.receipt.identity);
          expect(readmitted.receipt.identity).toMatchObject(initial);
          expect(readmitted.receipt.identity.isDirectory()).toBe(true);
          for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
            expect(readmitted.receipt.identity[field]).toEqual(initialDates[field]);
          }
          readmitted.receipt.identity.mode ^= 0o777;
          readmitted.receipt.identity.mtime.setUTCFullYear(2001);
          expect(independent.receipt.identity).toMatchObject(initial);
          expect(independent.receipt.identity.mtime).toEqual(initialDates.mtime);
          await expect(readmitted.assertCurrent()).resolves.toBeUndefined();
        } finally {
          await readmitted.close();
        }
        await expect(independent.assertCurrent()).resolves.toBeUndefined();
      } finally {
        await independent.close();
        await original.close();
      }
    },
  );

  it("snapshots safe caller-made metadata before asynchronous admission", async () => {
    const directory = await tempRoot("fs-safe-directory-external-metadata-");
    const lstat = fsSync.lstatSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const project = <T extends fsSync.Stats | fsSync.BigIntStats>(stat: T): T =>
      Object.assign(Object.create(stat), {
        dev: typeof stat.dev === "bigint" ? 1n : 1,
        ino: typeof stat.ino === "bigint" ? 42n : 42,
      });
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      return String(args[0]) === directory ? project(stat) : stat;
    });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => project(fstat(...args)));
    const identity = project(await fs.lstat(directory));
    identity.mode ^= 0o777;
    identity.mtimeMs = 1234.5;
    const admittedMode = identity.mode;
    const admittedMtime = new Date(identity.mtime.getTime());
    const pending = pinDirectory({ path: directory, realPath: directory, identity });
    identity.mode ^= 0o777;
    identity.mtimeMs = 5678.5;
    const pinned = await pending;
    try {
      expect(pinned.receipt.identity).not.toBe(identity);
      expect(pinned.receipt.identity).toMatchObject({ mode: admittedMode, mtimeMs: 1234.5 });
      expect(pinned.receipt.identity.mtime).toEqual(admittedMtime);
      await expect(pinned.assertCurrent()).resolves.toBeUndefined();
    } finally {
      await pinned.close();
    }
  });
});
