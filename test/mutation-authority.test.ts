import { describe, expect, it, vi } from "vitest";
import {
  assertSynchronousCallbackResult,
  composeMutationAssertions,
  MutationAuthorityError,
} from "../src/mutation-authority.js";

const wrappers: { name: string; wrap: (callback: () => unknown) => () => unknown }[] = [
  { name: "direct", wrap: callback => callback },
  { name: "bound", wrap: callback => callback.bind(undefined) },
  { name: "proxied", wrap: callback => new Proxy(callback, {}) },
];

describe.each(["sync", "async"] as const)("%s generator authority", kind => {
  it.each(wrappers)("rejects the $name callback result without advancing its body", ({ wrap }) => {
    const body = vi.fn();
    const callback = kind === "sync"
      ? function* () { body(); throw new Error("revoked"); }
      : async function* () { body(); throw new Error("revoked"); };
    const result = wrap(callback)();
    expect(() => assertSynchronousCallbackResult(result, "assertBeforeMutation"))
      .toThrow("assertBeforeMutation must be synchronous");
    expect(body).not.toHaveBeenCalled();
  });
});

it("stops composed authority before the next assertion when a generator is returned", () => {
  const body = vi.fn();
  const next = vi.fn();
  const assertion = composeMutationAssertions(function* () { body(); }, next)!;
  let failure: unknown;
  try { assertion(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(MutationAuthorityError);
  expect((failure as MutationAuthorityError).rejection).toBeInstanceOf(TypeError);
  expect(body).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

it("ignores ordinary synchronous values, iterables, iterator-like objects and functions", () => {
  const next = vi.fn();
  for (const value of [undefined, null, false, 0, "", Symbol("return"), 1n, [], {},
    new Set([1]), new Map().values(), { next }, function () {}, function* () {}]) {
    expect(() => assertSynchronousCallbackResult(value, "assertBeforeMutation")).not.toThrow();
  }
  expect(next).not.toHaveBeenCalled();
});

it("does not inspect iterator methods or accept a spoofed generator tag as an intrinsic generator", () => {
  const read = vi.fn(() => { throw new Error("iterator property must not be read"); });
  const value = Object.defineProperties({}, {
    next: { get: read },
    [Symbol.iterator]: { get: read },
    [Symbol.asyncIterator]: { get: read },
    [Symbol.toStringTag]: { value: "Generator" },
  });
  expect(() => assertSynchronousCallbackResult(value, "assertBeforeMutation")).not.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it("preserves the original then-getter failure before generator classification", () => {
  const rejection = { rejected: true };
  const body = vi.fn();
  const generator = (function* () { body(); })();
  for (const value of [{}, generator]) {
    const read = vi.fn(() => { throw rejection; });
    Object.defineProperty(value, "then", { get: read });
    let failure: unknown;
    try { assertSynchronousCallbackResult(value, "assertBeforeMutation"); }
    catch (error) { failure = error; }
    expect(failure).toBe(rejection);
    expect(read).toHaveBeenCalledOnce();
  }
  expect(body).not.toHaveBeenCalled();
});

it("reads a non-callable then once and still rejects intrinsic generators", () => {
  for (const [value, rejected] of [[{}, false], [(async function* () {})(), true]] as const) {
    const read = vi.fn(() => false);
    Object.defineProperty(value, "then", { get: read });
    if (rejected) {
      expect(() => assertSynchronousCallbackResult(value, "callback")).toThrow("callback must be synchronous");
    } else {
      expect(() => assertSynchronousCallbackResult(value, "callback")).not.toThrow();
    }
    expect(read).toHaveBeenCalledOnce();
  }
});

it("keeps thenable assimilation and rejection consumption ahead of generator classification", async () => {
  const body = vi.fn();
  const generator = (function* () { body(); })();
  const consumed = Promise.withResolvers<void>();
  const then = vi.fn((_resolve: unknown, reject: (reason: unknown) => void) => {
    reject(new Error("asynchronous refusal"));
    consumed.resolve();
  });
  const read = vi.fn(() => then);
  Object.defineProperty(generator, "then", { get: read });
  expect(() => assertSynchronousCallbackResult(generator, "callback")).toThrow("callback must be synchronous");
  await consumed.promise;
  expect(read).toHaveBeenCalledTimes(2);
  expect(then).toHaveBeenCalledOnce();
  expect(body).not.toHaveBeenCalled();
});
