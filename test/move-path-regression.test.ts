import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, itWin32, useTempDirs } from "./helpers/vitest.js";
import {
  moveCopyFallbackReasonForRenameError,
  movePathWithCopyFallback,
} from "../src/move-path.js";

const { tempRoot } = useTempDirs();

type Rename = typeof fsp.rename;

function spyOnRename(
  implementation: (
    from: Parameters<Rename>[0],
    to: Parameters<Rename>[1],
    rename: Rename,
  ) => Promise<void>,
): void {
  const rename = fsp.rename.bind(fsp);
  vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
    await implementation(from, to, rename);
  });
}


async function withProcessPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) {
    throw new Error("process.platform descriptor missing");
  }
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    await body();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("movePathWithCopyFallback regressions", () => {
  it("classifies only EXDEV and Windows EPERM as move copy fallbacks", () => {
    expect(
      moveCopyFallbackReasonForRenameError(
        Object.assign(new Error("cross-device"), { code: "EXDEV" }),
        "darwin",
      ),
    ).toBe("cross-device");
    expect(
      moveCopyFallbackReasonForRenameError(
        Object.assign(new Error("windows rename denied"), { code: "EPERM" }),
        "win32",
      ),
    ).toBe("windows-rename-denied");
    expect(
      moveCopyFallbackReasonForRenameError(
        Object.assign(new Error("posix permission denied"), { code: "EPERM" }),
        "darwin",
      ),
    ).toBeUndefined();
  });

  it("rejects a hardlinked source before a same-filesystem rename", async () => {
    const base = await tempRoot("fs-safe-move-rename-hardlink-");
    const source = path.join(base, "source.txt");
    const hardlink = path.join(base, "hardlink.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "source");
    await fsp.link(source, hardlink);
    const rename = vi.spyOn(fsp, "rename");

    await expectFsSafeError(movePathWithCopyFallback({ from: source, sourceHardlinks: "reject", to: dest }), "hardlink");

    expect(rename).not.toHaveBeenCalled();
    await expect(fsp.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fsp.readFile(hardlink, "utf8")).resolves.toBe("source");
    await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a fresh inode when hardlink rejection is enabled", async () => {
    const base = await tempRoot("fs-safe-move-reject-copy-");
    const source = path.join(base, "source.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "source");
    const sourceIdentity = await fsp.stat(source);
    const rename = vi.spyOn(fsp, "rename");

    await movePathWithCopyFallback({ from: source, sourceHardlinks: "reject", to: dest });

    expect(rename).not.toHaveBeenCalledWith(source, dest);
    const targetIdentity = await fsp.stat(dest);
    expect(targetIdentity.ino).not.toBe(sourceIdentity.ino);
    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("source");
    await expect(fsp.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a hardlink added after preflight without publishing a target", async () => {
    const base = await tempRoot("fs-safe-move-hardlink-race-");
    const source = path.join(base, "source.txt");
    const hardlink = path.join(base, "late-link.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "source");
    const realLstat = fsp.lstat;
    let sourceInspections = 0;
    vi.spyOn(fsp, "lstat").mockImplementation(async (candidate, options) => {
      const stat = await realLstat(candidate, options as never);
      if (candidate === source && ++sourceInspections === 1) {
        await fsp.link(source, hardlink);
      }
      return stat;
    });

    await expectFsSafeError(movePathWithCopyFallback({ from: source, sourceHardlinks: "reject", to: dest }), "hardlink");

    await expect(fsp.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fsp.readFile(hardlink, "utf8")).resolves.toBe("source");
    await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a directory move beneath itself before creating a staging tree", async () => {
    const source = await tempRoot("fs-safe-move-self-descendant-");
    await fsp.writeFile(path.join(source, "payload.txt"), "payload");
    const dest = path.join(source, "child");

    await expectFsSafeError(movePathWithCopyFallback({ from: source, sourceHardlinks: "reject", to: dest }), "invalid-path");

    await expect(fsp.readFile(path.join(source, "payload.txt"), "utf8")).resolves.toBe("payload");
    expect((await fsp.readdir(source)).toSorted()).toEqual(["payload.txt"]);
  });

  it("normalizes dot segments before rejecting a self-descendant move", async () => {
    const source = await tempRoot("fs-safe-move-self-normalized-");
    await fsp.mkdir(path.join(source, "sub"));
    await fsp.writeFile(path.join(source, "payload.txt"), "payload");
    const disguisedDest = path.join(source, "sub", "pivot", "..");

    await expectFsSafeError(movePathWithCopyFallback({
        from: source,
        sourceHardlinks: "reject",
        to: disguisedDest,
      }), "invalid-path");

    expect((await fsp.readdir(source)).toSorted()).toEqual(["payload.txt", "sub"]);
  });

  itPosix("rejects a self-descendant copy reached through a symlinked parent", async () => {
    const base = await tempRoot("fs-safe-move-self-symlink-");
    const source = path.join(base, "source");
    const alias = path.join(base, "alias");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "payload.txt"), "payload");
    await fsp.symlink(source, alias, "dir");

    await expectFsSafeError(movePathWithCopyFallback({
        from: source,
        sourceHardlinks: "reject",
        to: path.join(alias, "child"),
      }), "invalid-path");

    await expect(fsp.readFile(path.join(source, "payload.txt"), "utf8")).resolves.toBe(
      "payload",
    );
    expect((await fsp.readdir(source)).toSorted()).toEqual(["payload.txt"]);
  });

  itPosix("does not delete source entries replaced after an EXDEV copy", async () => {
    const base = await tempRoot("fs-safe-move-exdev-replaced-source-");
    const source = path.join(base, "source-dir");
    const dest = path.join(base, "dest-dir");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "copied.txt"), "copied");
    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      await rename(from, to);
      if (to === dest && String(from).includes(".fs-safe-move-")) {
        await fsp.rm(path.join(source, "copied.txt"));
        await fsp.writeFile(path.join(source, "copied.txt"), "replacement");
        await fsp.writeFile(path.join(source, "late.txt"), "late");
      }
    });

    await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
      code: "ESTALE",
    });

    await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
    await expect(fsp.readFile(path.join(source, "copied.txt"), "utf8")).resolves.toBe(
      "replacement",
    );
    await expect(fsp.readFile(path.join(source, "late.txt"), "utf8")).resolves.toBe("late");
  });

  itPosix("can reject hardlinked files during EXDEV move fallback", async () => {
    const base = await tempRoot("fs-safe-move-exdev-hardlink-");
    const source = path.join(base, "source.txt");
    const hardlink = path.join(base, "hardlink.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "source");
    await fsp.link(source, hardlink);
    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      return await rename(from, to);
    });

    await expect(
      movePathWithCopyFallback({ from: source, sourceHardlinks: "reject", to: dest }),
    ).rejects.toThrow("Refusing to move hardlinked file");

    await expect(fsp.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itWin32("falls back to copy/remove when rename is denied with EPERM", async () => {
    const base = await tempRoot("fs-safe-move-eperm-");
    const source = path.join(base, "source.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "windows lock fallback");

    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("rename denied"), { code: "EPERM" });
      }
      return await rename(from, to);
    });

    await movePathWithCopyFallback({ from: source, to: dest });

    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("windows lock fallback");
    await expect(fsp.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("restores the source when a Windows EPERM fallback cannot commit the staged copy", async () => {
    const base = await tempRoot("fs-safe-move-eperm-dest-denied-");
    const source = path.join(base, "source.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "source");

    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("initial rename denied"), { code: "EPERM" });
      }
      if (String(from).includes(".fs-safe-move-") && to === dest) {
        throw Object.assign(new Error("destination denied"), { code: "EPERM" });
      }
      return await rename(from, to);
    });

    await withProcessPlatform("win32", async () => {
      await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
        code: "EPERM",
      });
    });

    await expect(fsp.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.readdir(base)).resolves.toEqual(["source.txt"]);
  });

  itPosix("leaves the source visible when Windows EPERM cleanup fails after commit", async () => {
    const base = await tempRoot("fs-safe-move-eperm-cleanup-denied-");
    const source = path.join(base, "source.txt");
    const dest = path.join(base, "dest.txt");
    await fsp.writeFile(source, "source");

    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("initial rename denied"), { code: "EPERM" });
      }
      return await rename(from, to);
    });
    const realUnlink = fsp.unlink;
    vi.spyOn(fsp, "unlink").mockImplementation(async (target) => {
      if (target === source) {
        throw Object.assign(new Error("cleanup denied"), { code: "EBUSY" });
      }
      return await realUnlink(target);
    });

    await withProcessPlatform("win32", async () => {
      await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
        code: "EBUSY",
      });
    });

    await expect(fsp.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fsp.readFile(dest, "utf8")).resolves.toBe("source");
  });

  itPosix("preserves late source children during Windows EPERM fallback cleanup", async () => {
    const base = await tempRoot("fs-safe-move-eperm-late-child-");
    const source = path.join(base, "source-dir");
    const dest = path.join(base, "dest-dir");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "copied.txt"), "copied");

    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("initial rename denied"), { code: "EPERM" });
      }
      await rename(from, to);
      if (String(from).includes(".fs-safe-move-") && to === dest) {
        await fsp.writeFile(path.join(source, "late.txt"), "late");
      }
    });

    await withProcessPlatform("win32", async () => {
      await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
        code: "ESTALE",
      });
    });

    await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
    await expect(fsp.stat(path.join(source, "copied.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fsp.readFile(path.join(source, "late.txt"), "utf8")).resolves.toBe("late");
  });

  itPosix("preserves directory modes during EXDEV move fallback", async () => {
    const base = await tempRoot("fs-safe-move-exdev-dir-mode-");
    const source = path.join(base, "source-dir");
    const dest = path.join(base, "dest-dir");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "copied.txt"), "copied");
    await fsp.chmod(source, 0o777);
    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      return await rename(from, to);
    });
    const realMkdir = fsp.mkdir;
    vi.spyOn(fsp, "mkdir").mockImplementation(async (target, options) => {
      const result = await realMkdir(target, options as never);
      if (String(target).includes(".fs-safe-move-")) {
        await fsp.chmod(target, 0o700);
      }
      return result;
    });

    await movePathWithCopyFallback({ from: source, to: dest });

    expect((await fsp.stat(dest)).mode & 0o777).toBe(0o777);
    await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
  });

  itPosix("removes unchanged copied children when source directory gains a late child", async () => {
    const base = await tempRoot("fs-safe-move-exdev-added-source-");
    const source = path.join(base, "source-dir");
    const dest = path.join(base, "dest-dir");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "copied.txt"), "copied");
    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      await rename(from, to);
      if (to === dest && String(from).includes(".fs-safe-move-")) {
        await fsp.writeFile(path.join(source, "late.txt"), "late");
      }
    });

    await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
      code: "ESTALE",
    });

    await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
    await expect(fsp.stat(path.join(source, "copied.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fsp.readFile(path.join(source, "late.txt"), "utf8")).resolves.toBe("late");
  });

  itPosix("does not commit bytes from a source swapped after validation", async () => {
    const base = await tempRoot("fs-safe-move-exdev-source-swap-");
    const outside = await tempRoot("fs-safe-move-exdev-source-swap-outside-");
    const source = path.join(base, "source.txt");
    const dest = path.join(base, "dest.txt");
    const outsideFile = path.join(outside, "secret.txt");
    await fsp.writeFile(source, "inside");
    await fsp.writeFile(outsideFile, "secret");

    spyOnRename(async (from, to, rename) => {
      if (from === source && to === dest) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      return await rename(from, to);
    });
    const realLstat = fsp.lstat;
    let swapped = false;
    vi.spyOn(fsp, "lstat").mockImplementation(async (candidate, options) => {
      const stat = await realLstat(candidate, options as never);
      if (!swapped && candidate === source) {
        swapped = true;
        await fsp.rm(source);
        await fsp.symlink(outsideFile, source, "file");
      }
      return stat;
    });

    await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
      code: "ESTALE",
    });
    await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
