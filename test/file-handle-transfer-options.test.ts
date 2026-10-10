import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { copyFileHandle, type CopyFileHandleOptions } from "../src/advanced.js";
import { transferFileHandle } from "../src/file-handle-transfer.js";
import { useFileHandleTransferFixture } from "./helpers/file-handle-transfer.js";

const { fixture } = useFileHandleTransferFixture();

describe("borrowed FileHandle option snapshots", () => {
  it("stops partial writes when the selected signal aborts after its option is replaced", async () => {
    const f = await fixture("copied prefix", "original target with a tail");
    const selected = new AbortController();
    const replacement = new AbortController();
    const failure = new Error("selected signal aborted");
    const options: CopyFileHandleOptions = { signal: selected.signal };
    const realWrite = f.target.write.bind(f.target);
    let writtenBytes = 0;
    const write = vi.spyOn(f.target, "write").mockImplementation(async (buffer, offset, length, position) => {
      const result = await realWrite(buffer, offset, Math.min(length, 3), position);
      writtenBytes += result.bytesWritten;
      selected.abort(failure);
      return result;
    });

    const pending = copyFileHandle(f.source, f.target, options);
    options.signal = replacement.signal;

    await expect(pending).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1);
    expect(writtenBytes).toBeGreaterThan(0);
    expect(writtenBytes).toBeLessThanOrEqual(3);
    expect(replacement.signal.aborted).toBe(false);
    expect(await fs.readFile(f.targetPath)).toEqual(Buffer.concat([
      f.content.subarray(0, writtenBytes), Buffer.from(f.prior).subarray(writtenBytes),
    ]));
    await expect(f.source.stat()).resolves.toMatchObject({ size: f.content.length });
    await expect(f.target.stat()).resolves.toMatchObject({ size: Buffer.byteLength(f.prior) });
  });

  it("rechecks the selected authority after its option is replaced between partial writes", async () => {
    const f = await fixture("copied prefix", "original target with a tail");
    const failure = new Error("selected authority expired");
    let authorized = true;
    const selected = vi.fn(() => { if (!authorized) throw failure; });
    const replacement = vi.fn();
    const options: CopyFileHandleOptions = { assertBeforeMutation: selected };
    const realWrite = f.target.write.bind(f.target);
    let writtenBytes = 0;
    const write = vi.spyOn(f.target, "write").mockImplementation(async (buffer, offset, length, position) => {
      const result = await realWrite(buffer, offset, Math.min(length, 3), position);
      writtenBytes += result.bytesWritten;
      authorized = false;
      return result;
    });

    const pending = copyFileHandle(f.source, f.target, options);
    options.assertBeforeMutation = replacement;

    await expect(pending).rejects.toBe(failure);
    expect(selected).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(writtenBytes).toBeGreaterThan(0);
    expect(writtenBytes).toBeLessThanOrEqual(3);
    expect(await fs.readFile(f.targetPath)).toEqual(Buffer.concat([
      f.content.subarray(0, writtenBytes), Buffer.from(f.prior).subarray(writtenBytes),
    ]));
    await expect(f.source.stat()).resolves.toMatchObject({ size: f.content.length });
    await expect(f.target.stat()).resolves.toMatchObject({ size: Buffer.byteLength(f.prior) });
  });

  it("snapshots inherited non-enumerable option accessors before the first await", async () => {
    const f = await fixture("snapshot", "");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = f.source.read.bind(f.source);
    vi.spyOn(f.source, "read").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return await read(...args);
    });
    const selected = new AbortController();
    const replacement = new AbortController();
    let observerReceiver: unknown;
    const onChunk = vi.fn(function (this: unknown) { observerReceiver = this; });
    const replacementChunk = vi.fn(() => { throw new Error("late observer"); });
    const authority = vi.fn();
    const replacementAuthority = vi.fn(() => { throw new Error("late authority"); });
    let signal = selected.signal;
    let observer: CopyFileHandleOptions["onChunk"] = onChunk;
    let assertion: CopyFileHandleOptions["assertBeforeMutation"] = authority;
    let budget = f.content.length;
    const reads = { signal: 0, maxBytes: 0, onChunk: 0, assertBeforeMutation: 0 };
    const inherited = Object.defineProperties({}, {
      signal: { get: () => { reads.signal += 1; return signal; } },
      maxBytes: { get: () => { reads.maxBytes += 1; return budget; } },
      onChunk: { get: () => { reads.onChunk += 1; return observer; } },
      assertBeforeMutation: { get: () => { reads.assertBeforeMutation += 1; return assertion; } },
    });
    const pending = copyFileHandle(
      f.source, f.target, Object.create(inherited) as CopyFileHandleOptions,
    );
    try {
      await entered.promise;
      expect(reads).toEqual({ signal: 1, maxBytes: 1, onChunk: 1, assertBeforeMutation: 1 });
      signal = replacement.signal;
      observer = replacementChunk;
      assertion = replacementAuthority;
      budget = 0;
      replacement.abort(new Error("late signal"));
    } finally {
      release.resolve();
    }
    await expect(pending).resolves.toBe(f.content.length);
    expect(reads).toEqual({ signal: 1, maxBytes: 1, onChunk: 1, assertBeforeMutation: 1 });
    expect(onChunk).toHaveBeenCalled();
    expect(observerReceiver).toMatchObject({
      maxBytes: f.content.length, sizeHint: f.content.length, targetPosition: 0,
    });
    expect(Object.hasOwn(observerReceiver as object, "signal")).toBe(false);
    expect(Object.hasOwn(observerReceiver as object, "onChunk")).toBe(false);
    expect(Object.keys(observerReceiver as object)).toEqual([
      "maxBytes", "sizeHint", "targetPosition", "assertBeforeMutation",
    ]);
    expect(authority).toHaveBeenCalled();
    expect(replacementChunk).not.toHaveBeenCalled();
    expect(replacementAuthority).not.toHaveBeenCalled();
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
    await expect(f.source.stat()).resolves.toMatchObject({ size: f.content.length });
    await expect(f.target.stat()).resolves.toMatchObject({ size: f.content.length });
  });

  it.each(["getter", "descriptor"] as const)("retains a late %s failure without an observer", async (kind) => {
    const f = await fixture("content", "unchanged");
    const failure = new Error(`synthetic late ${kind} failure`);
    const events: string[] = [];
    const backing = Object.defineProperties({}, kind === "getter" ? {
      late: {
        enumerable: true,
        get() { events.push("get:late"); throw failure; },
      },
      hidden: { value: true },
    } : {
      signal: { value: undefined, enumerable: true, configurable: true },
      ignored: { value: true, enumerable: true, configurable: true },
    });
    const options = new Proxy(backing, {
      ownKeys(target) {
        events.push("ownKeys");
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        events.push(`descriptor:${String(key)}`);
        if (kind === "descriptor" && key === "signal") throw failure;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }) as CopyFileHandleOptions;
    const pending = copyFileHandle(f.source, f.target, options);
    expect(events).toEqual([]);
    await expect(pending).rejects.toBe(failure);
    expect(events).toEqual(kind === "getter"
      ? ["ownKeys", "descriptor:late", "get:late"] : ["ownKeys", "descriptor:signal"]);
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
  });

  it("preserves the direct transfer receiver while freezing inherited callbacks", async () => {
    const f = await fixture("content", "");
    const reads = { onChunk: 0, assertBeforeMutation: 0 };
    const replacementChunk = vi.fn();
    const replacementAuthority = vi.fn();
    let assertion = function (this: unknown) { expect(this).toBe(options); };
    let observer = function (this: unknown) {
      expect(this).toBe(options);
      assertion = replacementAuthority;
      observer = replacementChunk;
    };
    const inherited = Object.defineProperties({}, {
      onChunk: {
        get() { reads.onChunk += 1; return observer; },
      },
      assertBeforeMutation: {
        get() { reads.assertBeforeMutation += 1; return assertion; },
      },
    });
    const options = Object.assign(Object.create(inherited), { sizeHint: f.content.length });
    await expect(transferFileHandle(f.source, f.target, options)).resolves.toBe(f.content.length);
    expect(reads).toEqual({ onChunk: 1, assertBeforeMutation: 1 });
    expect(replacementChunk).not.toHaveBeenCalled();
    expect(replacementAuthority).not.toHaveBeenCalled();
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
  });

  it("keeps direct transfer option getter failures asynchronous and ordered", async () => {
    const f = await fixture("content", "unchanged");
    const failure = new Error("synthetic target position failure");
    const events: PropertyKey[] = [];
    const options = new Proxy({ sizeHint: f.content.length }, {
      get(target, key, receiver) {
        events.push(key);
        if (key === "targetPosition") throw failure;
        return Reflect.get(target, key, receiver);
      },
    });
    let pending!: Promise<number>;
    expect(() => {
      pending = transferFileHandle(f.source, f.target, options);
    }).not.toThrow();
    expect(events).toEqual(["maxBytes", "sizeHint", "targetPosition"]);
    await expect(pending).rejects.toBe(failure);
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
  });

  it("preserves proxy trap order and the spread-compatible observer receiver", async () => {
    const f = await fixture("content", "");
    const marker = Symbol("receiver marker");
    const markerValue = {};
    const selected = new AbortController();
    const events: string[] = [];
    let observerReceiver: unknown;
    let authorityReceiver: unknown = markerValue;
    const authority = function (this: unknown) { authorityReceiver = this; };
    const observer = function (this: unknown) { observerReceiver = this; };
    const prototype = Object.defineProperties({}, {
      maxBytes: { get() { return f.content.length; } },
      assertBeforeMutation: { get() { return authority; } },
    });
    const backing = Object.defineProperties(Object.create(prototype), {
      first: { value: "first", enumerable: true, configurable: true },
      signal: { value: selected.signal, enumerable: true, configurable: true },
      onChunk: { value: observer, enumerable: true, configurable: true },
      ["__proto__"]: { value: markerValue, enumerable: true, configurable: true },
      hidden: { value: true, configurable: true },
      last: { value: "last", enumerable: true, configurable: true },
      [marker]: { value: markerValue, enumerable: true, configurable: true },
    });
    const keyLabel = (key: PropertyKey) => typeof key === "symbol" ? String(key) : key;
    const options = new Proxy(backing, {
      get(target, key, receiver) {
        events.push(`get:${keyLabel(key)}`);
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        events.push("ownKeys");
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        events.push(`descriptor:${keyLabel(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }) as CopyFileHandleOptions;
    const pending = copyFileHandle(f.source, f.target, options);
    expect(events).toEqual([
      "get:signal", "get:maxBytes", "get:onChunk", "get:assertBeforeMutation",
    ]);
    await expect(pending).resolves.toBe(f.content.length);
    expect(events).toEqual([
      "get:signal", "get:maxBytes", "get:onChunk", "get:assertBeforeMutation",
      "ownKeys",
      "descriptor:first", "get:first",
      "descriptor:signal",
      "descriptor:onChunk",
      "descriptor:__proto__", "get:__proto__",
      "descriptor:hidden",
      "descriptor:last", "get:last",
      `descriptor:${String(marker)}`, `get:${String(marker)}`,
    ]);
    expect(Object.getPrototypeOf(observerReceiver)).toBe(Object.prototype);
    expect(Object.keys(observerReceiver as object)).toEqual([
      "first", "signal", "onChunk", "__proto__", "last",
      "maxBytes", "sizeHint", "targetPosition", "assertBeforeMutation",
    ]);
    expect(Reflect.ownKeys(observerReceiver as object)).toEqual([
      "first", "signal", "onChunk", "__proto__", "last",
      "maxBytes", "sizeHint", "targetPosition", "assertBeforeMutation", marker,
    ]);
    expect(observerReceiver).toMatchObject({
      first: "first", signal: selected.signal, onChunk: observer, last: "last",
      maxBytes: f.content.length, sizeHint: f.content.length, targetPosition: 0,
    });
    expect((observerReceiver as Record<PropertyKey, unknown>)[marker]).toBe(markerValue);
    expect(Object.getOwnPropertyDescriptor(observerReceiver, "__proto__")?.value).toBe(markerValue);
    expect(Object.hasOwn(observerReceiver as object, "hidden")).toBe(false);
    expect(authorityReceiver).toBeUndefined();
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
  });

  it("preserves late copy observer state without rereading captured option accessors", async () => {
    const f = await fixture("content", "");
    const marker = Symbol("receiver marker");
    const markerValue = {};
    let state = "original";
    const reads = { signal: 0, maxBytes: 0, onChunk: 0, assertBeforeMutation: 0, state: 0 };
    const authority = function (this: unknown) { expect(this).toBeUndefined(); };
    let observerCalls = 0;
    const observerTarget = function (this: Record<PropertyKey, unknown>, chunk: Uint8Array) {
      expect(this === options).toBe(false);
      expect(Object.getPrototypeOf(this)).toBe(Object.prototype);
      expect(this.state).toBe("replacement");
      expect(this[marker]).toBe(markerValue);
      expect(Object.getOwnPropertyDescriptor(this, "__proto__")?.value).toBe(markerValue);
      expect(this).toMatchObject({ sizeHint: f.content.length, targetPosition: 0, maxBytes: f.content.length });
      expect(this.hidden).toBeUndefined();
      expect(this.inherited).toBeUndefined();
      expect(chunk).toBeInstanceOf(Uint8Array);
      this.assertBeforeMutation = () => { throw new Error("replacement authority"); };
    };
    const callbackPropertyReads: PropertyKey[] = [];
    const observer = new Proxy(observerTarget, {
      apply(target, thisArg, argumentsList) {
        observerCalls += 1;
        expect(argumentsList).toHaveLength(1);
        return Reflect.apply(target, thisArg, argumentsList);
      },
      get(target, key, receiver) {
        callbackPropertyReads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const options = Object.defineProperties(Object.create({ inherited: true }), {
      [marker]: { value: markerValue, enumerable: true },
      ["__proto__"]: { value: markerValue, enumerable: true },
      hidden: { value: true },
      state: { enumerable: true, get() { reads.state += 1; return state; } },
      signal: { enumerable: true, get() { reads.signal += 1; return undefined; } },
      maxBytes: { enumerable: true, get() { reads.maxBytes += 1; return f.content.length; } },
      onChunk: { enumerable: true, get() { reads.onChunk += 1; return observer; } },
      assertBeforeMutation: { enumerable: true, get() { reads.assertBeforeMutation += 1; return authority; } },
    }) as CopyFileHandleOptions;
    // A callback's own call property must never replace its selected behavior.
    Object.defineProperty(observer, "call", { get() { throw new Error("unexpected callback.call"); } });
    const pending = copyFileHandle(f.source, f.target, options);
    expect(reads).toEqual({ signal: 1, maxBytes: 1, onChunk: 1, assertBeforeMutation: 1, state: 0 });
    state = "replacement";
    await expect(pending).resolves.toBe(f.content.length);
    expect(reads).toEqual({ signal: 1, maxBytes: 1, onChunk: 1, assertBeforeMutation: 1, state: 1 });
    expect(observerCalls).toBeGreaterThan(0);
    expect(callbackPropertyReads).toEqual([]);
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
  });

  it.each([
    { name: "observer-only", withSignal: false },
    { name: "signal-plus-observer", withSignal: true },
  ])("keeps the early authority snapshot after receiver mutation ($name)", async ({ withSignal }) => {
    const f = await fixture("short writes", "");
    const write = f.target.write.bind(f.target);
    vi.spyOn(f.target, "write").mockImplementation(async (buffer, offset, length, position) =>
      await write(buffer, offset, Math.min(length, 2), position));
    const controller = new AbortController();
    const lateAuthority = vi.fn(() => { throw new Error("late authority must stay inert"); });
    const reads = { signal: 0, maxBytes: 0, onChunk: 0, assertBeforeMutation: 0 };
    let receiver: Record<PropertyKey, unknown> | undefined;
    const backing: CopyFileHandleOptions = {
      ...(withSignal ? { signal: controller.signal } : {}),
      onChunk(this: Record<PropertyKey, unknown>) {
        receiver = this;
        this.assertBeforeMutation = lateAuthority;
        backing.assertBeforeMutation = lateAuthority;
      },
    };
    const options = new Proxy(backing, {
      get(target, key, proxyReceiver) {
        if (key in reads) reads[key as keyof typeof reads] += 1;
        return Reflect.get(target, key, proxyReceiver);
      },
    });

    await expect(copyFileHandle(f.source, f.target, options)).resolves.toBe(f.content.length);
    expect(reads).toEqual({ signal: 1, maxBytes: 1, onChunk: 1, assertBeforeMutation: 1 });
    expect(receiver).toBeDefined();
    expect(receiver).not.toBe(options);
    expect(lateAuthority).not.toHaveBeenCalled();
    expect(await fs.readFile(f.targetPath)).toEqual(f.content);
  });
});
