import syncFs from "node:fs";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  isUnsafeDeviceReadPath,
  matchUnsafeDeviceReadPath,
} from "../src/path.js";
import { openPinnedFileSync } from "../src/pinned-open.js";
import { readRegularFile, readRegularFileSync } from "../src/regular-file.js";
import { root, readLocalFileSafely } from "../src/root.js";
import { readSecureFile } from "../src/secure-file.js";

const posixIt = process.platform === "win32" ? it.skip : it;

describe("unsafe device read paths", () => {
  it("matches POSIX device and fd namespaces", () => {
    for (const filePath of [
      "/dev/zero",
      "/dev/random",
      "/dev/urandom",
      "/dev/full",
      "/dev/stdin",
      "/dev/stdout",
      "/dev/stderr",
      "/dev/tty",
      "/dev/console",
      "/dev/fd",
      "/dev/fd/0",
      "/dev/fd/99",
      "/proc/self/fd",
      "/proc/self/fd/0",
      "/proc/thread-self/fd/1",
      "/proc/123/fd/2",
    ]) {
      expect(isUnsafeDeviceReadPath(filePath, { platform: "linux" })).toBe(true);
    }
  });

  it("does not match ordinary POSIX paths that merely contain device-like names", () => {
    expect(isUnsafeDeviceReadPath("/tmp/dev/zero", { platform: "linux" })).toBe(false);
    expect(isUnsafeDeviceReadPath("dev/zero", { cwd: "/tmp/work", platform: "linux" })).toBe(
      false,
    );
    expect(isUnsafeDeviceReadPath("/dev/null", { platform: "linux" })).toBe(false);
  });

  it("matches Windows reserved device names", () => {
    for (const filePath of [
      "NUL",
      "C:\\tmp\\NUL.txt",
      "C:\\tmp\\con",
      "C:\\tmp\\COM¹.txt",
      "C:\\tmp\\LPT³",
      "logs\\COM1",
      "\\\\.\\NUL",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1",
    ]) {
      expect(matchUnsafeDeviceReadPath(filePath, { platform: "win32" })).toMatchObject({
        reason: "windows-device",
      });
    }
    expect(isUnsafeDeviceReadPath("C:\\tmp\\normal.txt", { platform: "win32" })).toBe(false);
  });

  posixIt("blocks async public file read primitives before open", async () => {
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async () => {
      throw new Error("open should not be called for unsafe device paths");
    });
    try {
      await expect(readLocalFileSafely({ filePath: "/dev/zero" })).rejects.toMatchObject({
        code: "device-path",
      });
      await expect(readRegularFile({ filePath: "/dev/zero" })).rejects.toMatchObject({
        code: "device-path",
      });
      await expect(
        readSecureFile({
          filePath: "/dev/zero",
          permissions: { allowInsecure: true },
        }),
      ).rejects.toMatchObject({ code: "device-path" });
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  posixIt("gives explicit device namespaces precedence over intermediate symlinks", async () => {
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async () => {
      throw new Error("open should not be called for unsafe device paths");
    });
    try {
      const scoped = await root("/");
      // /dev/fd is normally a symlink on Linux. The explicit unsafe namespace
      // remains a device-path error instead of depending on that host layout.
      await expect(scoped.read("dev/fd/0")).rejects.toMatchObject({
        code: "device-path",
      });
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  posixIt("blocks sync read helpers before open", () => {
    const openSpy = vi.spyOn(syncFs, "openSync").mockImplementation(() => {
      throw new Error("openSync should not be called for unsafe device paths");
    });
    try {
      expect(() => readRegularFileSync({ filePath: "/dev/fd/0" })).toThrowError(
        /unsafe device paths/,
      );
      const opened = openPinnedFileSync({ filePath: "/dev/fd/0" });
      expect(opened).toMatchObject({ ok: false, reason: "validation" });
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});
