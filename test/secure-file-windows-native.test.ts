import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NativeBinding,
  NativeWindowsDescriptorSecurityFacts,
  NativeWindowsSecurityFacts,
} from "../src/native-binding.js";
import {
  configureFsSafeNative,
  getFsSafeNativeConfig,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../src/native.js";
import { readSecureFile } from "../src/secure-file.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
let realNative: NativeBinding | undefined;
if (process.platform === "win32") {
  const nativeRequired = getFsSafeNativeConfig().mode === "require";
  try {
    realNative = __loadBundledNativeForTest();
  } catch (error) {
    if (nativeRequired) throw error;
  }
  if (nativeRequired && typeof realNative?.inspectWindowsSecureFileHandle !== "function") {
    throw new Error("Required native binding lacks inspectWindowsSecureFileHandle; rebuild the helper");
  }
}
const nativeSupported = typeof realNative?.inspectWindowsSecureFileHandle === "function";

function exactIdentity(fd: number): string {
  const stat = fsSync.fstatSync(fd, { bigint: true });
  return `${stat.dev.toString(16).padStart(8, "0")}:${stat.ino.toString(16).padStart(16, "0")}`;
}

function safeSecurity(): NativeWindowsSecurityFacts {
  return {
    ownerSid: "s-1-5-21-42",
    currentUserSid: "s-1-5-21-42",
    ownerClass: "current-user",
    worldWritable: false,
    groupWritable: false,
    worldReadable: false,
    groupReadable: false,
    fallbackRequired: false,
    daclPresent: true,
    isLocal: true,
    aceListComplete: true,
    unsupportedAceTypes: [],
    aces: [],
  };
}

async function privateFile(name: string): Promise<string> {
  const parent = await tempRoot(`fs-safe-secure-native-${name}-`);
  const directory = path.join(parent, "private");
  realNative!.createPrivateDirectory(directory);
  const file = path.join(directory, "secret");
  await fs.writeFile(file, "pinned secret");
  return file;
}

function installBinding(params: {
  inspect?: (fd: number) => NativeWindowsDescriptorSecurityFacts;
}): { inspect?: ReturnType<typeof vi.fn>; legacy: ReturnType<typeof vi.fn> } {
  const legacy = vi.fn(() => { throw new Error("legacy pathname ACL API must not run"); });
  const inspect = params.inspect && vi.fn(params.inspect);
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: vi.fn(),
    readOwnerAndDacl: legacy,
    ...(inspect ? { inspectWindowsSecureFileHandle: inspect } : {}),
  }) as unknown as NativeBinding);
  return { inspect, legacy };
}

function watchNextRead(): {
  read: () => ReturnType<typeof vi.spyOn> | undefined;
  close: () => ReturnType<typeof vi.spyOn> | undefined;
} {
  const open = fs.open.bind(fs);
  let read: ReturnType<typeof vi.spyOn> | undefined;
  let close: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    read = vi.spyOn(handle, "readFile");
    close = vi.spyOn(handle, "close");
    return handle;
  });
  return { read: () => read, close: () => close };
}

describe.runIf(nativeSupported)("native Windows secure descriptor ACL inspection", () => {
  beforeEach(() => {
    configureFsSafeNative({ mode: "require" });
    __resetNativeLoaderForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetFsSafeNativeConfigForTest();
    __resetNativeLoaderForTest();
  });

  it("reads an ordinary private file through the descriptor-bound ACL capability", async () => {
    const filePath = await privateFile("ordinary");
    const result = await readSecureFile({ filePath });
    expect(result.buffer.toString()).toBe("pinned secret");
    expect(result.permissions).toMatchObject({ source: "windows-acl", ownerTrusted: true });
  });

  it("keeps the borrowed descriptor open and its read position unchanged", async () => {
    const filePath = await privateFile("borrowed-lifetime");
    const handle = await fs.open(filePath, "r");
    try {
      const prefix = Buffer.alloc(7);
      await handle.read(prefix, 0, prefix.length, null);
      expect(prefix.toString()).toBe("pinned ");
      const expected = exactIdentity(handle.fd);
      const facts = realNative!.inspectWindowsSecureFileHandle!(handle.fd);
      expect(facts.identity).toBe(expected);
      expect(exactIdentity(handle.fd)).toBe(expected);
      expect((await handle.readFile()).toString()).toBe("secret");
    } finally {
      await handle.close();
    }
  });

  it("classifies LOCAL read access consistently with the native group summary", async () => {
    const filePath = await privateFile("local-readable");
    execFileSync(resolveWindowsSystemCommand("icacls.exe"), [filePath, "/grant", "*S-1-2-0:R"], {
      windowsHide: true,
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(realNative!.readOwnerAndDacl(filePath)).toMatchObject({
      worldReadable: false,
      groupReadable: true,
    });

    await expect(readSecureFile({ filePath }))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    const result = await readSecureFile({
      filePath,
      permissions: { allowReadableByOthers: true },
    });
    expect(result.buffer.toString()).toBe("pinned secret");
    expect(result.permissions).toMatchObject({
      source: "windows-acl",
      worldReadable: false,
      groupReadable: true,
    });
  });

  it("recognizes an extended-length local path from the pinned handle", async () => {
    const filePath = await privateFile("extended");
    const result = await readSecureFile({ filePath: `\\\\?\\${path.resolve(filePath)}` });
    expect(result.buffer.toString()).toBe("pinned secret");
    expect(result.permissions).toMatchObject({ source: "windows-acl", ownerTrusted: true });
  });

  it("reads an allowed symlink target through the same pinned descriptor", async () => {
    const target = await privateFile("symlink");
    const link = path.join(path.dirname(target), "alias");
    try {
      await fs.symlink(target, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        expect(error).toMatchObject({ code: "EPERM" });
        return;
      }
      throw error;
    }
    const result = await readSecureFile({ filePath: link, trust: { allowSymlink: true } });
    expect(result.buffer.toString()).toBe("pinned secret");
    expect(result.permissions).toMatchObject({ source: "windows-acl", ownerTrusted: true });
  });

  it.each([
    ["query failure", "permission-unverified", "throw"],
    ["malformed identity", "path-mismatch", "malformed"],
    ["identity mismatch", "path-mismatch", "mismatch"],
    ["malformed ACL facts", "permission-unverified", "malformed-security"],
    ["remote locality", "permission-unverified", "remote"],
    ["foreign owner", "not-owned", "foreign"],
  ] as const)("closes without reading on %s", async (_name, code, behavior) => {
    const filePath = await privateFile(`failure-${behavior}`);
    const watched = watchNextRead();
    const binding = installBinding({ inspect: (fd) => {
          if (behavior === "throw") throw new Error("descriptor query denied");
          if (behavior === "malformed") return { identity: "not-an-identity", security: safeSecurity() };
          const stat = fsSync.fstatSync(fd, { bigint: true });
          if (behavior === "mismatch") {
            return {
              identity: `${stat.dev.toString(16).padStart(8, "0")}:` +
                `${(stat.ino + 1n).toString(16).padStart(16, "0")}`,
              security: safeSecurity(),
            };
          }
          if (behavior === "malformed-security") {
            return {
              identity: exactIdentity(fd),
              security: { ...safeSecurity(), ownerClass: "trusted-ish" },
            } as NativeWindowsDescriptorSecurityFacts;
          }
          if (behavior === "foreign") {
            return {
              identity: exactIdentity(fd),
              security: { ...safeSecurity(), ownerClass: "foreign", ownerSid: "s-1-5-21-99" },
            };
          }
          return {
            identity: exactIdentity(fd),
            security: { ...safeSecurity(), isLocal: false, fallbackRequired: true },
          };
        } });
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(readSecureFile({ filePath, inject: { platform: "win32", exec } }))
      .rejects.toMatchObject({ code });
    expect(binding.legacy).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(watched.read()).not.toHaveBeenCalled();
    expect(watched.close()).toHaveBeenCalledOnce();
  });

  it("rejects pinned insecure bytes after a secure pathname substitution", async () => {
    const filePath = await privateFile("swap");
    const replacement = path.join(path.dirname(filePath), "replacement");
    const original = path.join(path.dirname(filePath), "original");
    await fs.writeFile(replacement, "secure replacement");
    execFileSync(resolveWindowsSystemCommand("icacls.exe"), [filePath, "/grant", "*S-1-1-0:R"], {
      windowsHide: true,
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(realNative!.readOwnerAndDacl(filePath)).toMatchObject({ worldReadable: true });
    expect(realNative!.readOwnerAndDacl(replacement)).toMatchObject({
      worldReadable: false,
      groupReadable: false,
    });

    const watched = watchNextRead();
    const binding = installBinding({ inspect: (fd) => {
      fsSync.renameSync(filePath, original);
      fsSync.renameSync(replacement, filePath);
      return realNative!.inspectWindowsSecureFileHandle!(fd);
    } });
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(readSecureFile({ filePath, inject: { platform: "win32", exec } }))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    expect(binding.inspect).toHaveBeenCalledOnce();
    expect(binding.legacy).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(watched.read()).not.toHaveBeenCalled();
    expect(watched.close()).toHaveBeenCalledOnce();
    expect(realNative!.readOwnerAndDacl(filePath)).toMatchObject({ worldReadable: false });
    expect(realNative!.readOwnerAndDacl(original)).toMatchObject({ worldReadable: true });
  });
});
