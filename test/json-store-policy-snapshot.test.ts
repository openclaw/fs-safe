import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createJsonStore, type JsonFileStoreOptions, type JsonStoreAdapter } from "../src/json-document-store.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("JsonStore per-mutation policy snapshots", () => {
  it.each(["write", "update", "updateOr"] as const)("captures %s before queueing and refreshes for later operations", async method => {
    const rootDir = await tempRoot("fs-safe-json-policy-");
    let durable = false;
    let trailingNewline = false;
    const reads = { durable: 0, trailingNewline: 0 };
    const options: JsonFileStoreOptions = Object.create({
      get durable() { expect(this).toBe(options); reads.durable++; return durable; },
      get trailingNewline() { expect(this).toBe(options); reads.trailingNewline++; return trailingNewline; },
      get unused(): never { throw new Error("unused getter"); },
    });
    const started = deferred();
    const release = deferred();
    let current: number | undefined;
    const written: Array<{ value: number; durable?: boolean; trailingNewline?: boolean }> = [];
    const adapter: JsonStoreAdapter<number> = {
      filePath: path.join(rootDir, "state.json"),
      async readIfExists() { expect(this).toBe(adapter); return current; },
      async readRequired() { return current!; },
      async write(value, policy) {
        expect(this).toBe(adapter);
        written.push({ value, ...policy });
        current = value;
      },
    };
    const store = createJsonStore(adapter, options);
    const blocker = createJsonStore(adapter).update(async () => {
      started.resolve();
      await release.promise;
      return 0;
    });
    await started.promise;
    const run = vi.fn(function (this: unknown, value: number | undefined) {
      expect(this).toBeUndefined();
      expect(value).toBe(0);
      durable = true;
      trailingNewline = true;
      return 1;
    });
    const pending = method === "write" ? store.write(1)
      : method === "update" ? store.update(run) : store.updateOr(0, run);
    expect(reads).toEqual({ durable: 1, trailingNewline: 1 });
    durable = true;
    trailingNewline = true;
    release.resolve();
    await blocker;
    await pending;
    expect(written[1]).toEqual({ value: 1, durable: false, trailingNewline: false });
    expect(run).toHaveBeenCalledTimes(method === "write" ? 0 : 1);
    await store.write(2);
    expect(written[2]).toEqual({ value: 2, durable: true, trailingNewline: true });
    expect(reads).toEqual({ durable: 2, trailingNewline: 2 });
  });

  it.each(["update", "updateOr"] as const)("captures %s before the read and async update callback", async method => {
    const rootDir = await tempRoot("fs-safe-json-update-policy-");
    const options = { durable: false, trailingNewline: false };
    const write = vi.fn(async () => {});
    const store = createJsonStore<number>({
      filePath: path.join(rootDir, "state.json"),
      async readIfExists() { options.durable = true; return undefined; },
      async readRequired() { return 0; },
      write,
    }, options);
    const run = async () => { await Promise.resolve(); options.trailingNewline = true; return 1; };
    if (method === "update") await store.update(run);
    else await store.updateOr(0, run);
    expect(write).toHaveBeenCalledExactlyOnceWith(1, { durable: false, trailingNewline: false });
  });
});
