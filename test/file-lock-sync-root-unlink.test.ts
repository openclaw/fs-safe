import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each(["missing", "directory", "io"] as const)(
  "retains release failure and permits retry after an unlink %s race",
  async fault => {
    const directory = await tempRoot("fs-safe-root-unlink-");
    const lockRoot = await root(directory);
    const owner = acquireFileLockSync(path.join(directory, "state"), {
      lockRoot, payload: () => ({ owner: "original" }),
    });
    const saved = `${owner.lockPath}.saved`;
    const unlink = fs.unlinkSync.bind(fs);
    const failure = Object.assign(new Error("unlink failed"), { code: "EIO" });
    const remove = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(name => {
      expect(String(name)).toBe(owner.lockPath);
      if (fault === "io") throw failure;
      fs.renameSync(owner.lockPath, saved);
      if (fault === "directory") fs.mkdirSync(owner.lockPath);
      unlink(name);
    });
    try {
      if (fault === "io") expect(() => owner.release()).toThrow(failure);
      else expect(() => owner.release()).toThrow();
      expect(remove).toHaveBeenCalledOnce();
      if (fault === "directory") {
        expect(fs.lstatSync(owner.lockPath).isDirectory()).toBe(true);
        fs.rmdirSync(owner.lockPath);
      }
      if (fault !== "io") fs.renameSync(saved, owner.lockPath);
      remove.mockRestore();
      expect(owner.verifyStillHeld()).toBe(true);
      owner.release();
      expect(fs.existsSync(owner.lockPath)).toBe(false);
    } finally {
      remove.mockRestore();
      owner.release();
    }
  },
);
