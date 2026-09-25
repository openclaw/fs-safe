import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAndCloseOpenedFile } from "../src/read-opened-file.js";
import { readLocalFileSafely, root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => __setFsSafeTestHooksForTest());

function openedFile() {
  const buffer = Buffer.from("payload");
  const read = vi.fn(async () => buffer);
  const close = vi.fn(async () => {});
  const handle = { readFile: read, close } as unknown as FileHandle;
  return {
    opened: { handle, stat: { size: buffer.length } as Stats, realPath: "/test/file", containment: "best-effort" as const },
    buffer, read, close,
  };
}

const failures = [
  { name: "Error", value: new Error("close failure") },
  { name: "undefined", value: undefined },
  { name: "null", value: null },
  { name: "false", value: false },
  { name: "zero", value: 0 },
  { name: "negative zero", value: -0 },
  { name: "bigint zero", value: 0n },
  { name: "empty string", value: "" },
  { name: "NaN", value: Number.NaN },
];

describe("admitted read owner settlement", () => {
  it("returns the admitted receipt and closes once with its original receiver", async () => {
    const subject = openedFile();
    const result = await readAndCloseOpenedFile({ opened: subject.opened });
    expect(result).toEqual({ buffer: subject.buffer, stat: subject.opened.stat, realPath: "/test/file", containment: "best-effort" });
    expect(subject.read.mock.contexts).toEqual([subject.opened.handle]);
    expect(subject.close.mock.contexts).toEqual([subject.opened.handle]);
    expect(subject.close).toHaveBeenCalledTimes(1);
  });

  it.each(failures)("preserves a read rejection containing $name after a successful close", async ({ value }) => {
    const subject = openedFile();
    subject.read.mockRejectedValueOnce(value);
    await expect(readAndCloseOpenedFile({ opened: subject.opened })).rejects.toBe(value);
    expect(subject.close).toHaveBeenCalledTimes(1);
  });

  describe.each([false, true])("read failed: %s", failed => {
    it.each(failures)("ignores a rejected close containing $name", async ({ value }) => {
      const subject = openedFile();
      const primary = new Error("read failure");
      if (failed) subject.read.mockRejectedValueOnce(primary);
      subject.close.mockRejectedValueOnce(value);
      const operation = readAndCloseOpenedFile({ opened: subject.opened });
      if (failed) await expect(operation).rejects.toBe(primary);
      else await expect(operation).resolves.toMatchObject({ buffer: subject.buffer });
      expect(subject.close).toHaveBeenCalledTimes(1);
    });

    describe.each(["getter", "call"] as const)("synchronous close %s", kind => {
      it.each(failures)("replaces the read outcome with $name", async ({ value }) => {
        const subject = openedFile();
        if (failed) subject.read.mockRejectedValueOnce(new Error("read failure"));
        const lookupReceivers: unknown[] = [];
        const callReceivers: unknown[] = [];
        Object.defineProperty(subject.opened.handle, "close", {
          get() {
            lookupReceivers.push(this);
            if (kind === "getter") throw value;
            return function(this: FileHandle) { callReceivers.push(this); throw value; };
          },
        });
        await expect(readAndCloseOpenedFile({ opened: subject.opened })).rejects.toBe(value);
        expect(lookupReceivers).toEqual([subject.opened.handle]);
        expect(callReceivers).toEqual(kind === "getter" ? [] : [subject.opened.handle]);
      });
    });
  });

  it.each([Number.NaN, -1, 0])("closes when validation rejects maxBytes %s before reading", async maxBytes => {
    const subject = openedFile();
    await expect(readAndCloseOpenedFile({ opened: subject.opened, maxBytes })).rejects.toThrow();
    expect(subject.read).not.toHaveBeenCalled();
    expect(subject.close).toHaveBeenCalledTimes(1);
  });

  it.each(["read getter", "read call", "result getter"])("closes after a synchronous %s failure", async phase => {
    const subject = openedFile();
    const primary = new Error(phase);
    if (phase === "read getter") Object.defineProperty(subject.opened.handle, "readFile", { get() { throw primary; } });
    else if (phase === "read call") subject.read.mockImplementationOnce(() => { throw primary; });
    else Object.defineProperty(subject.opened, "realPath", { get() { throw primary; } });
    await expect(readAndCloseOpenedFile({ opened: subject.opened })).rejects.toBe(primary);
    expect(subject.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a synchronous catch lookup failure from the close result", async () => {
    const subject = openedFile();
    const failure = new Error("catch lookup failed");
    Object.defineProperty(subject.opened.handle, "close", {
      value() { return Object.defineProperty({}, "catch", { get() { throw failure; } }); },
    });
    await expect(readAndCloseOpenedFile({ opened: subject.opened })).rejects.toBe(failure);
  });
});

it.each(["Root.read", "local read"] as const)("%s retains captured limits and waits for its read and close", async reader => {
  const directory = await tempRoot("fs-safe-owned-read-");
  const filePath = path.join(directory, "value.txt");
  await fs.writeFile(filePath, "payload");
  const scoped = await root(directory);
  const readEntered = Promise.withResolvers<void>();
  const readRelease = Promise.withResolvers<void>();
  const closeEntered = Promise.withResolvers<void>();
  const closeRelease = Promise.withResolvers<void>();
  const events: string[] = [];
  let limitReads = 0;
  const options = { filePath, get maxBytes() { limitReads++; return 64; } };
  let restore = () => {};
  let originalClose: (() => Promise<void>) | undefined;
  let handle: FileHandle | undefined;
  let settled = false;
  __setFsSafeTestHooksForTest({
    afterOpen(openedPath, opened) {
      if (openedPath !== filePath) return;
      handle = opened;
      Object.defineProperty(options, "maxBytes", { get() { throw new Error("late external cap read"); } });
      const readDescriptor = Object.getOwnPropertyDescriptor(opened, "read");
      const closeDescriptor = Object.getOwnPropertyDescriptor(opened, "close");
      const originalRead = opened.read;
      originalClose = opened.close.bind(opened);
      restore = () => {
        if (readDescriptor) Object.defineProperty(opened, "read", readDescriptor);
        else Reflect.deleteProperty(opened, "read");
        if (closeDescriptor) Object.defineProperty(opened, "close", closeDescriptor);
        else Reflect.deleteProperty(opened, "close");
      };
      Object.defineProperty(opened, "read", {
        configurable: true,
        value: async function(this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
          events.push("read-started");
          readEntered.resolve();
          await readRelease.promise;
          try { return await Reflect.apply(originalRead, this, args); }
          finally { events.push("read-settled"); }
        },
      });
      Object.defineProperty(opened, "close", {
        configurable: true,
        get() {
          expect(this).toBe(opened);
          events.push("close-lookup");
          return async function(this: FileHandle) {
            expect(this).toBe(opened);
            events.push("close-started");
            closeEntered.resolve();
            await closeRelease.promise;
            await originalClose!();
            events.push("close-settled");
          };
        },
      });
    },
  });
  const operation = (reader === "Root.read" ? scoped.read("value.txt", options) : readLocalFileSafely(options))
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    .then(result => { settled = true; events.push("outer-settled"); return result; });
  try {
    await Promise.race([readEntered.promise, operation.then(() => { throw new Error("read did not reach barrier"); })]);
    expect(events).toEqual(["read-started"]);
    expect(settled).toBe(false);
    readRelease.resolve();
    await Promise.race([closeEntered.promise, operation.then(() => { throw new Error("close did not reach barrier"); })]);
    expect(events.at(-2)).toBe("close-lookup");
    expect(events.at(-1)).toBe("close-started");
    expect(events.indexOf("read-settled")).toBeLessThan(events.indexOf("close-lookup"));
    expect(settled).toBe(false);
    closeRelease.resolve();
    const result = await operation;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.buffer.toString()).toBe("payload");
    expect(limitReads).toBe(1);
    expect(events.filter(event => event === "close-lookup")).toHaveLength(1);
    expect(events.slice(-2)).toEqual(["close-settled", "outer-settled"]);
  } finally {
    readRelease.resolve();
    closeRelease.resolve();
    await operation;
    restore();
    if (handle && handle.fd !== -1) await originalClose?.();
  }
});
