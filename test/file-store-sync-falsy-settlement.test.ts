import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStoreSync } from "../src/store.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const FALSY_THROWN_VALUES = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "zero", value: 0 },
  { label: "empty string", value: "" },
  { label: "zero bigint", value: 0n },
  { label: "NaN", value: Number.NaN },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function captureSyncFailure(run: () => unknown): { error: unknown } {
  try {
    run();
  } catch (error) {
    return { error };
  }
  throw new Error("Expected synchronous operation to throw");
}

describe("sync store falsy settlement", () => {
  for (const testCase of FALSY_THROWN_VALUES) {
    it(`preserves a successful publication close throwing ${testCase.label}`, async () => {
      const root = await tempRoot("fs-safe-falsy-store-close-");
      const filePath = path.join(root, "value");
      const realOpenSync = fsSync.openSync;
      const realCloseSync = fsSync.closeSync;
      let tempDescriptor: number | undefined;
      vi.spyOn(fsSync, "openSync").mockImplementation((candidate, flags, mode) => {
        const descriptor = realOpenSync(candidate, flags, mode);
        if (String(candidate).endsWith(".tmp")) tempDescriptor = descriptor;
        return descriptor;
      });
      vi.spyOn(fsSync, "closeSync").mockImplementation((descriptor) => {
        realCloseSync(descriptor);
        if (descriptor === tempDescriptor) throw testCase.value;
      });

      const failure = captureSyncFailure(() =>
        fileStoreSync({ rootDir: root, durable: false }).write("value", "published"));
      expect(failure.error).toBe(testCase.value);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("published");
    });
  }

  it("retains original undefined when its published handle close also fails", async () => {
    const root = await tempRoot("fs-safe-falsy-store-original-close-");
    const filePath = path.join(root, "value");
    const realOpenSync = fsSync.openSync;
    const realCloseSync = fsSync.closeSync;
    const realRenameSync = fsSync.renameSync;
    let tempDescriptor: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = realOpenSync(candidate, flags, mode);
      if (String(candidate).endsWith(".tmp")) tempDescriptor = descriptor;
      return descriptor;
    });
    vi.spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
      realRenameSync(source, destination);
      throw undefined;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation((descriptor) => {
      realCloseSync(descriptor);
      if (descriptor === tempDescriptor) throw false;
    });

    const failure = captureSyncFailure(() =>
      fileStoreSync({ rootDir: root, durable: false }).write("value", "published"));
    expect(failure.error).toBeInstanceOf(AggregateError);
    const aggregate = failure.error as AggregateError;
    expect(aggregate.message).toBe("Atomic file replace and close failed");
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBeUndefined();
    expect(aggregate.errors[1]).toBe(false);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("published");
  });
});
