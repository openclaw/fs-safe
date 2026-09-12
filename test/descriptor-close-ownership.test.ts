import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publishFileExclusive } from "../src/publish-file.js";
import { replaceFileAtomicSync } from "../src/replace-file.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

const failure = () => Object.assign(new Error("late filesystem failure"), { code: "EIO" });
function isOpen(fd: number, stat = fsSync.fstatSync): boolean {
  try { stat(fd); return true; } catch { return false; }
}
function nativeCopy(target: string, created: (fd: number) => void): NativeBinding {
  return {
    linkBeneath() { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
    cloneFileExclusive(sourceFd: number) {
      const bytes = Buffer.alloc(fsSync.fstatSync(sourceFd).size);
      fsSync.readSync(sourceFd, bytes, 0, bytes.length, 0);
      const fd = fsSync.openSync(target, "wx", 0o600);
      fsSync.writeSync(fd, bytes);
      created(fd);
      return fd;
    },
    async sha256File(fd: number) {
      const bytes = Buffer.alloc(fsSync.fstatSync(fd).size);
      fsSync.readSync(fd, bytes, 0, bytes.length, 0);
      return { bytes: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
    },
  } as NativeBinding;
}

it.each([false, true])("closes a created publication descriptor after initial stat failure (native=%s)", async (native) => {
  const dir = await tempRoot("fs-safe-publication-stat-");
  const source = path.join(dir, "source"), target = path.join(dir, "target");
  await fs.writeFile(source, "source bytes");
  let createdFd: number | undefined;
  let createdHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const stat = fsSync.fstatSync, error = failure();
  if (native) {
    configureFsSafeNative({ mode: "auto" });
    __setNativeLoaderForTest(() => nativeCopy(target, (fd) => { createdFd = fd; }));
  } else {
    configureFsSafeNative({ mode: "off" });
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === target) { createdFd = handle.fd; createdHandle = handle; }
      return handle;
    });
  }
  let injected = false;
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args: Parameters<typeof fsSync.fstatSync>) => {
    if (args[0] === createdFd && !injected) { injected = true; throw error; }
    return stat(...args);
  });
  try {
    await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }))
      .rejects.toBe(error);
    expect(injected).toBe(true);
    expect(isOpen(createdFd!, stat)).toBe(false);
    expect(await fs.readFile(source, "utf8")).toBe("source bytes");
  } finally {
    vi.restoreAllMocks();
    if (createdHandle) await createdHandle.close().catch(() => {});
    else if (createdFd !== undefined && isOpen(createdFd, stat)) fsSync.closeSync(createdFd);
  }
});

it("does not retry a native publication close after the descriptor number was released", async () => {
  const dir = await tempRoot("fs-safe-publication-close-");
  const source = path.join(dir, "source"), target = path.join(dir, "target"), other = path.join(dir, "other");
  await fs.writeFile(source, "source bytes");
  await fs.writeFile(other, "unrelated bytes");
  let nativeFd: number | undefined, otherFd: number | undefined;
  let injected = false;
  const close = fsSync.closeSync, error = failure();
  configureFsSafeNative({ mode: "auto" });
  __setNativeLoaderForTest(() => nativeCopy(target, (fd) => { nativeFd = fd; }));
  vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    if (fd === nativeFd && !injected) {
      injected = true;
      close(fd);
      otherFd = fsSync.openSync(other, "r");
      throw error;
    }
    close(fd);
  });
  try {
    await expect(publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "link-or-copy" }))
      .rejects.toMatchObject({ cause: error });
    expect(injected).toBe(true);
    expect(isOpen(otherFd!)).toBe(true);
    expect(fsSync.readFileSync(otherFd!, "utf8")).toBe("unrelated bytes");
  } finally {
    vi.restoreAllMocks();
    if (otherFd !== undefined && isOpen(otherFd)) close(otherFd);
  }
});

it("does not retry an atomic temp close after content verification adopts a new inode", async () => {
  const dir = await tempRoot("fs-safe-atomic-close-");
  const target = path.join(dir, "target"), other = path.join(dir, "other");
  await fs.writeFile(other, "unrelated bytes");
  let tempFd: number | undefined, otherFd: number | undefined;
  let injected = false;
  const error = failure();
  const fileSystem = {
    ...fsSync,
    openSync(...args: Parameters<typeof fsSync.openSync>) {
      const fd = fsSync.openSync(...args);
      if (args[1] === "wx") tempFd = fd;
      return fd;
    },
    renameSync(from: fsSync.PathLike, to: fsSync.PathLike) {
      fsSync.copyFileSync(from, to);
      fsSync.unlinkSync(from);
    },
    closeSync(fd: number) {
      if (fd === tempFd && !injected) {
        injected = true;
        fsSync.closeSync(fd);
        otherFd = fsSync.openSync(other, "r");
        throw error;
      }
      fsSync.closeSync(fd);
    },
  };
  try {
    expect(() => replaceFileAtomicSync({ filePath: target, content: "replacement", fileSystem,
      renameIdentity: "verify-content-with-lock" })).toThrow(error);
    expect(injected).toBe(true);
    expect(isOpen(otherFd!)).toBe(true);
    expect(fsSync.readFileSync(otherFd!, "utf8")).toBe("unrelated bytes");
  } finally {
    if (otherFd !== undefined && isOpen(otherFd)) fsSync.closeSync(otherFd);
  }
});
