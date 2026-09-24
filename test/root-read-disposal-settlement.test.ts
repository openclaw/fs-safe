import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalFileSafely, root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const cleanups: Array<() => Promise<void>> = [];
const readers = ["Root.read", "Root.readText", "readLocalFileSafely"] as const;
const failures = [
  { name: "Error", value: new Error("injected failure") },
  { name: "undefined", value: undefined },
  { name: "null", value: null },
  { name: "false", value: false },
  { name: "zero", value: 0 },
  { name: "negative zero", value: -0 },
  { name: "bigint zero", value: 0n },
  { name: "empty string", value: "" },
  { name: "NaN", value: Number.NaN },
];
type Failure = { value: unknown };
type CloseFailure = Failure & { kind: "reject" | "throw" | "getter" };

afterEach(async () => {
  __setFsSafeTestHooksForTest();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function fixture(
  reader: (typeof readers)[number],
  readFailure?: Failure,
  closeFailure?: CloseFailure,
) {
  const directory = await tempRoot("fs-safe-read-disposal-");
  const filePath = path.join(directory, "value.txt");
  await fs.writeFile(filePath, "real file payload");
  const scoped = await root(directory);
  const readEntered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const closeEntered = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const events: string[] = [];
  const closeReceivers: unknown[] = [];
  const getterReceivers: unknown[] = [];
  let handle: FileHandle | undefined;
  let restore = () => {};
  let closeOriginal: (() => Promise<void>) | undefined;
  let settled = false;
  let pending: Promise<unknown> | undefined;

  __setFsSafeTestHooksForTest({
    afterOpen(openedPath, opened) {
      if (openedPath !== filePath) return;
      handle = opened;
      const readMethod = reader === "readLocalFileSafely" ? "readFile" : "read";
      const originalRead = opened[readMethod];
      closeOriginal = opened.close.bind(opened);
      const descriptors = [readMethod, "close"].map(name =>
        [name, Object.getOwnPropertyDescriptor(opened, name)] as const);
      restore = () => {
        for (const [name, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(opened, name, descriptor);
          else Reflect.deleteProperty(opened, name);
        }
      };
      Object.defineProperty(opened, readMethod, {
        configurable: true,
        value: async function(this: FileHandle, ...args: unknown[]) {
          events.push("read-started");
          readEntered.resolve();
          await releaseRead.promise;
          try {
            if (readFailure) throw readFailure.value;
            return await Reflect.apply(originalRead, this, args);
          } finally {
            events.push("read-settled");
          }
        },
      });
      Object.defineProperty(opened, "close", {
        configurable: true,
        get() {
          getterReceivers.push(this);
          events.push("close-lookup");
          if (closeFailure?.kind === "getter") throw closeFailure.value;
          return function(this: FileHandle) {
            closeReceivers.push(this);
            events.push("close-started");
            closeEntered.resolve();
            if (closeFailure?.kind === "throw") throw closeFailure.value;
            return (async () => {
              await releaseClose.promise;
              await closeOriginal!();
              events.push("close-settled");
              if (closeFailure?.kind === "reject") throw closeFailure.value;
            })();
          };
        },
      });
    },
  });
  cleanups.push(async () => {
    releaseRead.resolve();
    releaseClose.resolve();
    try {
      await pending;
    } finally {
      restore();
      if (handle && handle.fd !== -1) await closeOriginal?.();
    }
  });

  return {
    readEntered, releaseRead, closeEntered, releaseClose, events,
    get settled() { return settled; },
    start() {
      const operation = reader === "Root.read"
        ? scoped.read("value.txt")
        : reader === "Root.readText"
          ? scoped.readText("value.txt")
          : readLocalFileSafely({ filePath });
      const result = operation.then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }),
      ).finally(() => {
        settled = true;
        events.push("outer-settled");
      });
      pending = result;
      return result;
    },
    expectOneClose() {
      expect(handle).toBeDefined();
      expect(getterReceivers).toEqual([handle]);
      expect(closeReceivers).toEqual(closeFailure?.kind === "getter" ? [] : [handle]);
    },
  };
}

describe.each(readers)("%s disposal settlement", reader => {
  it.each(["success", "failure"] as const)("waits for the held read and close (%s)", async outcome => {
    const primary = new Error("read failed after release");
    const observed = await fixture(reader, outcome === "failure" ? { value: primary } : undefined);
    const pending = observed.start();
    await Promise.race([
      observed.readEntered.promise,
      pending.then(() => { throw new Error("read settled before entering the barrier"); }),
    ]);
    expect(observed.events).toEqual(["read-started"]);
    expect(observed.settled).toBe(false);
    observed.releaseRead.resolve();
    await Promise.race([
      observed.closeEntered.promise,
      pending.then(() => { throw new Error("read settled before entering close"); }),
    ]);
    expect(observed.events).toEqual(["read-started", "read-settled", "close-lookup", "close-started"]);
    expect(observed.settled).toBe(false);
    observed.releaseClose.resolve();
    const result = await pending;
    expect(observed.events.at(-2)).toBe("close-settled");
    expect(observed.events.at(-1)).toBe("outer-settled");
    expect(result.ok).toBe(outcome === "success");
    if (result.ok) {
      expect(typeof result.value === "string" ? result.value : result.value.buffer.toString())
        .toBe("real file payload");
    } else {
      expect(result.error).toBe(primary);
    }
    observed.expectOneClose();
  });

  it.each([{ name: "successful read", failure: undefined }, ...failures.map(failure => ({
    name: `read rejects ${failure.name}`, failure,
  }))])("swallows rejected close after $name", async ({ failure }) => {
    const observed = await fixture(reader, failure, { kind: "reject", value: new Error("close rejected") });
    observed.releaseRead.resolve();
    observed.releaseClose.resolve();
    const result = await observed.start();
    expect(result.ok).toBe(failure === undefined);
    if (!result.ok) expect(Object.is(result.error, failure!.value)).toBe(true);
    else expect(typeof result.value === "string" ? result.value : result.value.buffer.toString())
      .toBe("real file payload");
    observed.expectOneClose();
  });

  describe.each(["throw", "getter"] as const)("synchronous close %s", kind => {
    it("replaces a successful read with the exact close failure", async () => {
      const failure = new Error("close failed after successful read");
      const observed = await fixture(reader, undefined, { kind, value: failure });
      observed.releaseRead.resolve();
      observed.releaseClose.resolve();
      const result = await observed.start();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(failure);
      observed.expectOneClose();
    });

    it.each(failures)("replaces the read failure with the exact $name value", async ({ value }) => {
      const observed = await fixture(reader, { value: new Error("primary read failure") }, { kind, value });
      observed.releaseRead.resolve();
      observed.releaseClose.resolve();
      const result = await observed.start();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(Object.is(result.error, value)).toBe(true);
      observed.expectOneClose();
    });
  });
});
