import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDarwinAcl } from "../src/darwin-acl.js";
import type { NativeBinding, NativeDarwinAclFacts } from "../src/native-binding.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";

beforeEach(() => configureFsSafeNative({ mode: "auto" }));

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function install(facts: unknown) {
  const inspect = vi.fn(() => facts as NativeDarwinAclFacts);
  __setNativeLoaderForTest(() => ({ inspectDarwinAcl: inspect, closeOwnedFd: vi.fn() }) as unknown as NativeBinding);
  return inspect;
}

describe("internal Darwin descriptor ACL capability", () => {
  it.each(["absent", "empty", "present"] as const)("preserves the %s fact without applying policy", state => {
    const native = install({ state });
    expect(inspectDarwinAcl(42)).toEqual({ state });
    expect(native).toHaveBeenCalledExactlyOnceWith(42);
  });

  it.each([undefined, null, false, 0, "empty", {}, { state: "unknown" }, { state: 0 }])(
    "rejects malformed or incomplete facts: %j", facts => {
      const native = install(facts);
      expect(() => inspectDarwinAcl(42)).toThrowError(expect.objectContaining({ code: "permission-unverified" }));
      expect(native).toHaveBeenCalledOnce();
    },
  );

  it.each(["ENOTSUP", "EINVAL", "EIO", "EBADF", "EACCES"])("preserves %s inspection failure as the cause", code => {
    const native = install({ state: "absent" });
    const cause = Object.assign(new Error("descriptor query failed"), { code });
    native.mockImplementation(() => { throw cause; });
    expect(() => inspectDarwinAcl(42)).toThrowError(expect.objectContaining({ code: "permission-unverified", cause }));
  });

  it.each(["auto", "require"] as const)("rejects an older binding without ACL capability in %s mode", mode => {
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn() }) as unknown as NativeBinding);
    expect(() => inspectDarwinAcl(42)).toThrowError(expect.objectContaining({ code: "helper-unavailable" }));
  });

  it.each(["auto", "require"] as const)("rejects a missing addon in %s mode", mode => {
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => { throw new Error("addon unavailable"); });
    expect(() => inspectDarwinAcl(42)).toThrowError(expect.objectContaining({ code: "helper-unavailable" }));
  });

  it("does not load the addon in off mode", () => {
    configureFsSafeNative({ mode: "off" });
    const loader = vi.fn(() => ({}) as NativeBinding);
    __setNativeLoaderForTest(loader);
    expect(() => inspectDarwinAcl(42)).toThrowError(expect.objectContaining({ code: "helper-unavailable" }));
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, 0x8000_0000])("rejects invalid descriptor %s before dispatch", fd => {
    const native = install({ state: "absent" });
    expect(() => inspectDarwinAcl(fd)).toThrowError(expect.objectContaining({ code: "permission-unverified" }));
    expect(native).not.toHaveBeenCalled();
  });
});
