import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NativeBinding,
  NativeWindowsDescriptorSecurityFacts,
  NativeWindowsSecurityFacts,
} from "../src/native-binding.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { inspectSecureWindowsDescriptor } from "../src/secure-file-windows.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const FLAGS = {
  raw: 0,
  objectInherit: false,
  containerInherit: false,
  noPropagateInherit: false,
  inheritOnly: false,
  inherited: false,
  successfulAccess: false,
  failedAccess: false,
};

function security(overrides: Partial<NativeWindowsSecurityFacts> = {}): NativeWindowsSecurityFacts {
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
    ...overrides,
  };
}

function identity(dev: bigint, ino: bigint): string {
  return `${dev.toString(16).padStart(8, "0")}:${ino.toString(16).padStart(16, "0")}`;
}

function install(
  inspect: (fd: number) => NativeWindowsDescriptorSecurityFacts,
): ReturnType<typeof vi.fn> {
  const method = vi.fn(inspect);
  __setNativeLoaderForTest(() => ({
    inspectWindowsSecureFileHandle: method,
    readOwnerAndDacl: vi.fn(() => security()),
  }) as unknown as NativeBinding);
  return method;
}

describe("secure Windows descriptor ACL facts", () => {
  let stat: fsSync.Stats;

  beforeEach(async () => {
    configureFsSafeNative({ mode: "require" });
    const root = await tempRoot("fs-safe-secure-win-facts-");
    const file = path.join(root, "secret");
    await fs.writeFile(file, "secret");
    stat = fsSync.statSync(file);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetFsSafeNativeConfigForTest();
    __resetNativeLoaderForTest();
  });

  it("compares identities above 2^53 without converting through number", () => {
    const expected = { dev: 0xffff_fffen, ino: 0x0020_0000_0000_0001n };
    const method = install(() => ({ identity: identity(expected.dev, expected.ino), security: security() }));
    expect(inspectSecureWindowsDescriptor({ fd: 73, identity: expected, stat })).toMatchObject({
      source: "windows-acl",
      ownerTrusted: true,
    });
    expect(method).toHaveBeenCalledWith(73);
  });

  it.each([
    "4e561b19:002000000000000",
    "4E561B19:0020000000000001",
    "0x4e561b19:0020000000000001",
    " 4e561b19:0020000000000001",
    "4e561b19:+020000000000001",
  ])("rejects noncanonical native identity %j", (nativeIdentity) => {
    install(() => ({ identity: nativeIdentity, security: security() }));
    expect(() => inspectSecureWindowsDescriptor({
      fd: 1,
      identity: { dev: 0x4e56_1b19n, ino: 0x0020_0000_0000_0001n },
      stat,
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });

  it("rejects a definite descriptor identity mismatch", () => {
    install(() => ({ identity: "4e561b19:0020000000000002", security: security() }));
    expect(() => inspectSecureWindowsDescriptor({
      fd: 1,
      identity: { dev: 0x4e56_1b19n, ino: 0x0020_0000_0000_0001n },
      stat,
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });

  it.each([
    ["fallback", { fallbackRequired: true }],
    ["remote", { isLocal: false }],
    ["incomplete", { aceListComplete: false }],
    ["unsupported", { unsupportedAceTypes: [9] }],
    ["unknown owner class", { ownerClass: "trusted-ish" }],
    ["inconsistent owner class", { ownerClass: "system" }],
  ] as const)("fails closed on %s security facts", (_name, overrides) => {
    const expected = { dev: 1n, ino: 2n };
    install(() => ({ identity: identity(expected.dev, expected.ino), security: security(overrides) }));
    expect(() => inspectSecureWindowsDescriptor({ fd: 1, identity: expected, stat }))
      .toThrow(expect.objectContaining({ code: "permission-unverified" }));
  });

  it("recomputes the conservative ACL summary instead of trusting booleans", () => {
    const expected = { dev: 1n, ino: 2n };
    install(() => ({
      identity: identity(expected.dev, expected.ino),
      security: security({
        aces: [{ sid: "s-1-1-0", mask: 1, aceType: "allow", flags: FLAGS }],
      }),
    }));
    expect(() => inspectSecureWindowsDescriptor({ fd: 1, identity: expected, stat }))
      .toThrow(expect.objectContaining({ code: "permission-unverified" }));
  });

  it.each([
    ["world", "s-1-1-0", { worldReadable: true, groupReadable: false }],
    ["LOCAL", "s-1-2-0", { worldReadable: false, groupReadable: true }],
    ["foreign group", "s-1-5-21-99", { worldReadable: false, groupReadable: true }],
    ["current user", "s-1-5-21-42", { worldReadable: false, groupReadable: false }],
    ["LocalSystem", "s-1-5-18", { worldReadable: false, groupReadable: false }],
    ["Administrators", "s-1-5-32-544", { worldReadable: false, groupReadable: false }],
  ] as const)("matches the native summary for a readable %s ACE", (_name, sid, summary) => {
    const expected = { dev: 1n, ino: 2n };
    install(() => ({
      identity: identity(expected.dev, expected.ino),
      security: security({
        ...summary,
        aces: [{ sid, mask: 1, aceType: "allow", flags: FLAGS }],
      }),
    }));
    expect(inspectSecureWindowsDescriptor({ fd: 1, identity: expected, stat }))
      .toMatchObject(summary);
  });

  it.each([
    ["deny", { aceType: "deny", flags: FLAGS }],
    ["inherit-only", { aceType: "allow", flags: { ...FLAGS, raw: 8, inheritOnly: true } }],
  ] as const)("does not count a readable %s ACE", (_name, ace) => {
    const expected = { dev: 1n, ino: 2n };
    install(() => ({
      identity: identity(expected.dev, expected.ino),
      security: security({ aces: [{ sid: "s-1-1-0", mask: 1, ...ace }] }),
    }));
    expect(inspectSecureWindowsDescriptor({ fd: 1, identity: expected, stat }))
      .toMatchObject({ worldReadable: false, groupReadable: false });
  });

  it.each([
    ["null", false, {
      worldReadable: true, worldWritable: true, groupReadable: false, groupWritable: false,
    }],
    ["empty", true, {
      worldReadable: false, worldWritable: false, groupReadable: false, groupWritable: false,
    }],
  ] as const)("matches the native summary for a %s DACL", (_name, daclPresent, summary) => {
    const expected = { dev: 1n, ino: 2n };
    install(() => ({
      identity: identity(expected.dev, expected.ino),
      security: security({ daclPresent, ...summary }),
    }));
    expect(inspectSecureWindowsDescriptor({ fd: 1, identity: expected, stat }))
      .toMatchObject(summary);
  });

  it.each([
    ["system", "s-1-5-18"],
    ["administrators", "s-1-5-32-544"],
  ] as const)("accepts the explicit trusted %s owner class", (ownerClass, ownerSid) => {
    const expected = { dev: 1n, ino: 2n };
    install(() => ({
      identity: identity(expected.dev, expected.ino),
      security: security({ ownerClass, ownerSid }),
    }));
    expect(inspectSecureWindowsDescriptor({ fd: 1, identity: expected, stat }).ownerTrusted).toBe(true);
  });

  it("does not trust a well-formed foreign owner", () => {
    const expected = { dev: 1n, ino: 2n };
    install(() => ({
      identity: identity(expected.dev, expected.ino),
      security: security({ ownerClass: "foreign", ownerSid: "s-1-5-21-99" }),
    }));
    expect(inspectSecureWindowsDescriptor({ fd: 1, identity: expected, stat }).ownerTrusted).toBe(false);
  });

  it.each(["off", "auto", "require"] as const)("fails closed on a stale helper in %s mode", (mode) => {
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => ({ readOwnerAndDacl: vi.fn() }) as unknown as NativeBinding);
    expect(() => inspectSecureWindowsDescriptor({ fd: 1, identity: { dev: 1n, ino: 2n }, stat }))
      .toThrow(expect.objectContaining({ code: "permission-unverified" }));
  });

  it("fails closed when the helper cannot load or its query throws", () => {
    __setNativeLoaderForTest(() => { throw new Error("native package missing"); });
    expect(() => inspectSecureWindowsDescriptor({ fd: 1, identity: { dev: 1n, ino: 2n }, stat }))
      .toThrow(expect.objectContaining({ code: "permission-unverified", cause: expect.any(Error) }));
    __setNativeLoaderForTest(() => ({
      readOwnerAndDacl: vi.fn(),
      inspectWindowsSecureFileHandle: vi.fn(() => { throw new Error("query denied"); }),
    }) as unknown as NativeBinding);
    expect(() => inspectSecureWindowsDescriptor({ fd: 1, identity: { dev: 1n, ino: 2n }, stat }))
      .toThrow(expect.objectContaining({ code: "permission-unverified", cause: expect.any(Error) }));
  });
});
