import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectiveUid } from "../src/effective-uid.js";
import { safeFileURLToPath } from "../src/local-file-access.js";

const originalProvider = Object.getOwnPropertyDescriptor(process, "geteuid");
afterEach(() => {
  if (originalProvider) Object.defineProperty(process, "geteuid", originalProvider);
  else Reflect.deleteProperty(process, "geteuid");
});

function provide(value: unknown): string[] {
  const events: string[] = [];
  Object.defineProperty(process, "geteuid", {
    configurable: true,
    get() {
      events.push("provider lookup");
      return function(this: typeof process) {
        events.push(this === process ? "process receiver" : "wrong receiver");
        return value;
      };
    },
  });
  return events;
}

describe("effective identity admission", () => {
  it.each([0, -0, 1, Number.MAX_SAFE_INTEGER])("preserves accepted uid %s and captures its provider once", value => {
    const events = provide(value);
    expect(Object.is(resolveEffectiveUid(), value)).toBe(true);
    expect(events).toEqual(["provider lookup", "process receiver"]);
  });

  it.each([undefined, null, false, "0", 0n, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid uid %s without accepting a coerced identity",
    value => {
      const events = provide(value);
      expect(() => resolveEffectiveUid()).toThrow("Effective user identity is unavailable.");
      expect(events).toEqual(["provider lookup", "process receiver"]);
    },
  );

  it("rejects a hostile identity without invoking conversion hooks", () => {
    let conversions = 0;
    const events = provide({
      [Symbol.toPrimitive]() { conversions++; throw new Error("identity coercion"); },
      valueOf() { conversions++; throw new Error("identity coercion"); },
    });
    expect(() => resolveEffectiveUid()).toThrow("Effective user identity is unavailable.");
    expect(conversions).toBe(0);
    expect(events).toEqual(["provider lookup", "process receiver"]);
  });

  it("preserves a provider lookup failure without calling it", () => {
    expect.assertions(1);
    const failure = new Error("provider lookup failed");
    Object.defineProperty(process, "geteuid", {
      configurable: true,
      get() { throw failure; },
    });
    try {
      resolveEffectiveUid();
    } catch (error) {
      expect(error).toBe(failure);
    }
  });

  it("retains the exact cause when the captured provider fails", () => {
    expect.assertions(2);
    const failure = new Error("provider failed");
    Object.defineProperty(process, "geteuid", {
      configurable: true,
      value() { throw failure; },
    });
    try {
      resolveEffectiveUid();
    } catch (error) {
      expect(error).toHaveProperty("message", "Effective user identity is unavailable.");
      expect((error as Error).cause).toBe(failure);
    }
  });
});

describe("local file URL admission order", () => {
  it.each([
    { platform: "linux" as const, url: "file://LoCaLhOsT/tmp/value.txt", expected: "/tmp/value.txt" },
    { platform: "win32" as const, url: "file://LoCaLhOsT/C:/tmp/value.txt", expected: "C:\\tmp\\value.txt" },
  ])("accepts a canonical localhost URL for $platform", ({ platform, url, expected }) => {
    expect(safeFileURLToPath(url, platform)).toBe(expected);
  });

  it("rejects the protocol before host and encoded-separator policy", () => {
    expect(() => safeFileURLToPath("https://remote.example/a%2Fb"))
      .toThrow("Invalid file:// URL");
  });

  it("rejects a remote host before examining encoded separators", () => {
    expect(() => safeFileURLToPath("file://remote.example/a%2Fb"))
      .toThrow("file:// URLs with remote hosts are not allowed");
  });
});
