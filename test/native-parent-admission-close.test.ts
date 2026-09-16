import fsSync from "node:fs";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { openNativeParentAdmission, openNativeRootAdmission } from "../src/native-parent-admission.js";
import type { NativeBinding } from "../src/native.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
});

it.each(["win32", "linux"] as const)("preserves %s root-admission disposal semantics", async platform => {
  const directory = await tempRoot("fs-safe-root-admission-close-");
  const actualOpen = fs.open.bind(fs);
  const closeFailure = new Error("root closed before reporting failure");
  let descriptor = -1;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    descriptor = handle.fd;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      await close();
      throw closeFailure;
    });
    return handle;
  });
  const identity = await fs.lstat(directory, { bigint: true });
  Object.defineProperty(process, "platform", { value: platform });
  const failure = await openNativeRootAdmission({ openBeneath: vi.fn(), closeOwnedFd: vi.fn() } as unknown as NativeBinding, {
    rootPath: directory,
    rootIdentity: { dev: identity.dev, ino: identity.ino + 1n },
  }).catch(error => error);

  if (platform === "win32") expect(failure).toMatchObject({ code: "path-mismatch" });
  else expect(failure).toMatchObject({ name: "SuppressedError", error: closeFailure, suppressed: { code: "path-mismatch" } });
  expect(() => fsSync.fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it.each(["win32", "linux"] as const)("preserves %s parent-admission disposal semantics", async platform => {
  const directory = await tempRoot("fs-safe-parent-admission-close-");
  const root = await fs.open(directory, fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0));
  const admissionFailure = new FsSafeError("invalid-path", "canonical alias", {
    details: { reason: "windows-path-alias" },
  });
  const closeFailure = new Error("parent closed before reporting failure");
  const actualClose = fsSync.closeSync.bind(fsSync);
  let descriptor = -1;
  const binding = {
    closeOwnedFd: (fd: number) => fsSync.closeSync(fd),
    openBeneath: (_root: number, _relative: string, flags: number) => {
      descriptor = fsSync.openSync(directory, flags);
      return { fd: descriptor, containment: "best-effort" };
    },
  } as unknown as NativeBinding;
  vi.spyOn(realpathSync, "native").mockImplementation(() => { throw admissionFailure; });
  const close = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
    actualClose(fd);
    if (fd === descriptor) throw closeFailure;
  });
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const failure = await openNativeParentAdmission(binding, {
      root, rootPath: directory, exactRoot: true, operation: "move",
    }, "").catch(error => error);
    if (platform === "win32") expect(failure).toBe(admissionFailure);
    else expect(failure).toMatchObject({ name: "SuppressedError", error: closeFailure, suppressed: admissionFailure });
    expect(close.mock.calls.filter(([fd]) => fd === descriptor)).toHaveLength(1);
    expect(() => fsSync.fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  } finally {
    vi.restoreAllMocks();
    await root.close();
  }
});
