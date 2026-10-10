import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenedFileRealPathForFd } from "../src/opened-realpath.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

describe("Linux opened-file procfs observation", () => {
  it.skipIf(process.platform !== "linux")("canonicalizes a deleted descriptor suffix that names a symlink", async () => {
    const directory = await tempRoot("fs-safe-procfs-deleted-link-");
    const original = path.join(directory, "original");
    const kept = path.join(directory, "kept");
    fs.writeFileSync(original, "payload");
    fs.linkSync(original, kept);
    const fd = fs.openSync(original, "r");
    try {
      const identity = fs.fstatSync(fd, { bigint: true });
      fs.unlinkSync(original);
      fs.symlinkSync(kept, `${original} (deleted)`);
      const result = await resolveOpenedFileRealPathForFd(fd, identity, original);
      expect(result.realPath).toBe(kept);
      expect(result.stat.ino).toBe(identity.ino);
    } finally { fs.closeSync(fd); }
  });

  it.skipIf(process.platform !== "linux")("retains a live literal deleted-suffix filename", async () => {
    const directory = await tempRoot("fs-safe-procfs-literal-suffix-");
    const target = path.join(directory, "file (deleted)");
    fs.writeFileSync(target, "payload");
    const fd = fs.openSync(target, "r");
    try {
      const identity = fs.fstatSync(fd, { bigint: true });
      const result = await resolveOpenedFileRealPathForFd(fd, identity, target);
      expect(result.realPath).toBe(target);
      expect(result.stat.ino).toBe(identity.ino);
    } finally { fs.closeSync(fd); }
  });

  it.each([false, true])("uses the physical descriptor path with bigint=%s", async (bigint) => {
    const directory = await tempRoot("fs-safe-procfs-observation-");
    const target = path.join(directory, "file");
    fs.writeFileSync(target, "payload");
    const fd = fs.openSync(target, "r");
    try {
      const identity = bigint ? fs.fstatSync(fd, { bigint: true }) : fs.fstatSync(fd);
      Object.defineProperty(process, "platform", { value: "linux" });
      const lookup = vi.spyOn(fs, "readlinkSync").mockReturnValue(target);
      const canonicalize = vi.spyOn(realpathSync, "native");
      const stat = vi.spyOn(fs, "statSync");
      const result = await resolveOpenedFileRealPathForFd(fd, identity, target);
      expect(result).toMatchObject({ realPath: target, stat: { dev: identity.dev, ino: identity.ino } });
      expect(lookup).toHaveBeenCalledExactlyOnceWith(`/proc/self/fd/${fd}`);
      expect(canonicalize).not.toHaveBeenCalled();
      expect(stat).toHaveBeenCalledExactlyOnceWith(...(bigint ? [target, { bigint: true }] : [target]));
    } finally { fs.closeSync(fd); }
  });

  it.each(["unavailable", "relative", "different inode"])("retains fallback for %s evidence", async (scenario) => {
    const directory = await tempRoot("fs-safe-procfs-fallback-");
    const target = path.join(directory, "target");
    const other = path.join(directory, "other");
    fs.writeFileSync(target, "payload"); fs.writeFileSync(other, "other");
    const fd = fs.openSync(target, "r");
    try {
      const identity = fs.fstatSync(fd, { bigint: true });
      Object.defineProperty(process, "platform", { value: "linux" });
      vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
        if (scenario === "unavailable") throw Object.assign(new Error("no procfs"), { code: "ENOENT" });
        return scenario === "relative" ? "target" : other;
      });
      const canonicalize = vi.spyOn(realpathSync, "native").mockReturnValue(target);
      const result = await resolveOpenedFileRealPathForFd(fd, identity, target);
      expect(result.realPath).toBe(target);
      expect(result.stat.ino).toBe(identity.ino);
      expect(canonicalize).toHaveBeenCalledExactlyOnceWith(`/dev/fd/${fd}`);
    } finally { fs.closeSync(fd); }
  });

  it.skipIf(process.platform === "win32")("does not accept an ancestor substitution after the descriptor lookup", async () => {
    const directory = await tempRoot("fs-safe-procfs-swap-");
    const parent = path.join(directory, "parent");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(parent);
    const target = path.join(parent, "file");
    fs.writeFileSync(target, "original");
    const fd = fs.openSync(target, "r");
    try {
      const identity = fs.fstatSync(fd, { bigint: true });
      Object.defineProperty(process, "platform", { value: "linux" });
      vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
        fs.renameSync(parent, moved);
        fs.mkdirSync(parent);
        fs.writeFileSync(target, "replacement");
        return target;
      });
      const realpath = realpathSync.native;
      vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
        if (candidate === `/dev/fd/${fd}`) throw Object.assign(new Error("no fd alias"), { code: "ENOENT" });
        return realpath(candidate);
      });
      await expect(resolveOpenedFileRealPathForFd(fd, identity, target)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(fs.readFileSync(target, "utf8")).toBe("replacement");
      expect(fs.readFileSync(fd, "utf8")).toBe("original");
    } finally { fs.closeSync(fd); }
  });
});
