import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeWindowsSecurityFacts } from "../src/native-binding.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { inspectPathPermissions, type PermissionCheck } from "../src/permissions-public.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const baseKeys = [
  "ok", "isSymlink", "isDir", "mode", "bits", "source",
  "worldWritable", "groupWritable", "worldReadable", "groupReadable",
];
const ownerKeys = ["ownerSid", "ownerTrusted"];
const errorKeys = ["error", "errorDetail", "errorCause"];
let target: string;

function expectShape(result: PermissionCheck, extraKeys: string[] = []) {
  const keys = [...baseKeys, ...extraKeys];
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Reflect.ownKeys(result)).toEqual(keys);
  for (const key of keys) {
    expect(Object.getOwnPropertyDescriptor(result, key)).toEqual({
      value: result[key as keyof PermissionCheck],
      writable: true, enumerable: true, configurable: true,
    });
  }
}

function facts(): NativeWindowsSecurityFacts {
  return {
    ownerSid: "s-1-5-21-42", currentUserSid: "s-1-5-21-42", ownerClass: "current-user",
    worldWritable: true, groupWritable: true, worldReadable: true, groupReadable: true,
    fallbackRequired: false, daclPresent: true, isLocal: true, aceListComplete: true,
    unsupportedAceTypes: [], aces: [],
  };
}

function installNative(value: NativeWindowsSecurityFacts) {
  configureFsSafeNative({ mode: "require" });
  const readOwnerAndDacl = vi.fn(() => value);
  __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), readOwnerAndDacl }) as unknown as NativeBinding);
  return readOwnerAndDacl;
}

function ownerQuery(complete = true) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      ownerSid: "S-1-5-21-42", currentUserSid: "S-1-5-21-42", remote: false,
      complete, daclPresent: true,
      aces: [{ sid: "S-1-5-21-99", mask: 1, deny: false, inheritOnly: false }],
    }),
    stderr: "",
  }));
}

beforeEach(async () => {
  configureFsSafeNative({ mode: "off" });
  target = path.join(await tempRoot("fs-safe-permission-result-"), "ordinary.txt");
  await fs.writeFile(target, "ordinary permission fixture", { mode: 0o600 });
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("public permission result ownership", () => {
  it("returns independently writable native results with the established field order", async () => {
    const nativeFacts = facts();
    const read = installNative(nativeFacts);
    const exec = ownerQuery();
    const first = await inspectPathPermissions(target, { platform: "win32", exec });
    const second = await inspectPathPermissions(target, { platform: "win32", exec });
    expectShape(first, [...ownerKeys, "aclSummary"]);
    expectShape(second, [...ownerKeys, "aclSummary"]);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    first.ownerSid = "caller-owned";
    first.worldWritable = false;
    expect(second.ownerSid).toBe(nativeFacts.ownerSid);
    expect(second.worldWritable).toBe(true);
    expect(second.aclSummary).toBe("native owner=current-user world=rw group=rw");
    expect(read).toHaveBeenCalledTimes(2);
    expect(exec).not.toHaveBeenCalled();
  });

  it("retains structured-query success and incomplete-ACL result shapes", async () => {
    const successful = await inspectPathPermissions(target, { platform: "win32", exec: ownerQuery() });
    expectShape(successful, [...ownerKeys, "aclSummary"]);
    expect(successful).toMatchObject({ source: "windows-acl", groupReadable: true, ownerTrusted: true });
    const incomplete = await inspectPathPermissions(target, { platform: "win32", exec: ownerQuery(false) });
    expectShape(incomplete, [...ownerKeys, ...errorKeys]);
    expect(incomplete).toMatchObject({
      source: "unknown", ownerTrusted: true, groupReadable: false,
      errorDetail: undefined, errorCause: undefined,
    });
    expect(successful).not.toHaveProperty("error");
  });

  it("discards native fields when late summary access throws before a failed fallback", async () => {
    const nativeFacts = facts();
    let ownerReads = 0;
    Object.defineProperty(nativeFacts, "ownerClass", {
      get() {
        if (++ownerReads === 2) throw new Error("late native summary failure");
        return "current-user";
      },
    });
    const read = installNative(nativeFacts);
    read.mockReturnValueOnce(nativeFacts).mockReturnValue(facts());
    const cause = new Error("fallback owner query failed");
    const exec = vi.fn(async () => { throw cause; });
    const result = await inspectPathPermissions(target, { platform: "win32", exec });
    expect(ownerReads).toBe(2);
    expectShape(result, ["ownerError", ...errorKeys]);
    expect(result).toMatchObject({
      source: "unknown", worldWritable: false, groupWritable: false,
      worldReadable: false, groupReadable: false,
      ownerError: "Error: fallback owner query failed",
      error: "Windows owner inspection failed: Error: fallback owner query failed",
      errorDetail: undefined,
    });
    expect(result.errorCause).toBe(cause);
    const snapshot = Object.getOwnPropertyDescriptors(result);
    const next = await inspectPathPermissions(target, { platform: "win32", exec });
    expectShape(next, [...ownerKeys, "aclSummary"]);
    expect(next).toMatchObject({ source: "windows-acl", worldWritable: true });
    expect(Object.getOwnPropertyDescriptors(result)).toEqual(snapshot);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("keeps POSIX and failed-stat results free of Windows-only fields", async () => {
    const posix = await inspectPathPermissions(target, { platform: "linux" });
    expectShape(posix);
    expect(posix).toMatchObject({ ok: true, source: "posix" });
    const missing = await inspectPathPermissions(`${target}.missing`, { platform: "linux" });
    expectShape(missing, ["error"]);
    expect(missing).toMatchObject({ ok: false, source: "unknown", mode: null, bits: null });
  });
});
