import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { fileStoreSync } from "../src/file-store.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sync file-store write validation", () => {
  it("retains a write-capable temp descriptor through fsync", async () => {
    const root = await tempRoot("fs-safe-sync-store-write-handle-");
    const realOpenSync = fsSync.openSync;
    let tempFlags: string | number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((filePath, flags, mode) => {
      if (filePath.toString().endsWith(".tmp")) tempFlags = flags;
      return realOpenSync(filePath, flags, mode);
    });

    const store = fileStoreSync({ rootDir: root });
    expect(store.writeText("value.txt", "value")).toBe(path.join(root, "value.txt"));
    expect(tempFlags).toBe("wx");
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("value");
  });

  itPosix.each([false, true])(
    "fsyncs the temp before rename and the parent after publication (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-sync-store-durability-order-");
      const events: string[] = [];
      const realFsyncSync = fsSync.fsyncSync;
      const realRenameSync = fsSync.renameSync;
      vi.spyOn(fsSync, "fsyncSync").mockImplementation((descriptor) => {
        events.push("fsync");
        realFsyncSync(descriptor);
      });
      vi.spyOn(fsSync, "renameSync").mockImplementation((source, target) => {
        events.push("rename");
        realRenameSync(source, target);
      });

      const store = fileStoreSync({ rootDir: root, private: privateMode });
      expect(store.writeText("value.txt", "value")).toBe(path.join(root, "value.txt"));
      expect(events).toEqual(["fsync", "rename", "fsync"]);
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("value");
    },
  );

  itPosix("preserves the destination when temp fsync fails", async () => {
    const root = await tempRoot("fs-safe-sync-store-temp-fsync-");
    const failure = Object.assign(new Error("temp fsync failed"), { code: "EIO" });
    vi.spyOn(fsSync, "fsyncSync").mockImplementationOnce(() => {
      throw failure;
    });

    const store = fileStoreSync({ rootDir: root });
    expect(() => store.writeText("value.txt", "value")).toThrow("temp fsync failed");
    await expect(fs.access(path.join(root, "value.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  itPosix("reports parent fsync failure after publication", async () => {
    const root = await tempRoot("fs-safe-sync-store-parent-fsync-");
    const realFsyncSync = fsSync.fsyncSync;
    let syncCalls = 0;
    vi.spyOn(fsSync, "fsyncSync").mockImplementation((descriptor) => {
      syncCalls += 1;
      if (syncCalls === 2) {
        throw Object.assign(new Error("parent fsync failed"), { code: "EIO" });
      }
      realFsyncSync(descriptor);
    });

    const store = fileStoreSync({ rootDir: root });
    expect(() => store.writeText("value.txt", "value")).toThrow("parent fsync failed");
    expect(syncCalls).toBe(2);
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("value");
  });

  itPosix.each([false, true])(
    "rejects a post-rename symlink swap without chmodding its target (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-sync-store-write-swap-");
      const outside = await tempRoot("fs-safe-sync-store-write-outside-");
      const filePath = path.join(root, "value.txt");
      const outsidePath = path.join(outside, "outside.txt");
      await fs.writeFile(outsidePath, "outside", { mode: 0o644 });
      await fs.chmod(outsidePath, 0o644);

      const realRenameSync = fsSync.renameSync;
      vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
        realRenameSync(from, to);
        if (to !== filePath) return;
        fsSync.rmSync(filePath);
        fsSync.symlinkSync(outsidePath, filePath, "file");
      });

      const store = fileStoreSync({ rootDir: root, private: privateMode, mode: 0o600 });
      expectFsSafeErrorSync(() => store.writeText("value.txt", "inside"), "path-mismatch");
      expect((await fs.stat(outsidePath)).mode & 0o777).toBe(0o644);
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    },
  );
});
