import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each([
  "setup-abort", "setup-error", "read-abort", "read-error", "filter-error", "filter-undefined",
  "close-only", "iterator-return", "iterator-throw", "iterator-throw-undefined",
] as const)(
  "retains walk and close failures after %s",
  async (phase) => {
    const directory = await tempRoot("fs-safe-walk-close-failure-");
    await fs.writeFile(path.join(directory, "entry"), "value");
    const capability = await root(directory);
    const controller = new AbortController();
    const primaryFailure = phase.endsWith("undefined") ? undefined : new Error(`${phase} failed`);
    const closeFailure = new Error("directory close failed");
    let closeAttempts = 0;
    const opendir = fs.opendir.bind(fs);
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const handle = await opendir(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeAttempts += 1;
        await close();
        throw closeFailure;
      });
      if (phase === "setup-abort") controller.abort(primaryFailure);
      if (phase === "setup-error") {
        vi.spyOn(fsSync, "lstatSync").mockImplementationOnce(() => { throw primaryFailure; });
      }
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async () => {
        if (phase === "read-error") throw primaryFailure;
        const entry = await read();
        if (phase === "read-abort") controller.abort(primaryFailure);
        return entry;
      });
      return handle;
    });

    const iterator = capability.walk("", {
      order: "filesystem",
      symlinkPolicy: "skip",
      signal: controller.signal,
      onDirectoryError: phase.endsWith("abort") ? "skip-and-report" : "throw",
      entryFilter: () => {
        if (phase === "filter-error" || phase === "filter-undefined") throw primaryFailure;
        return "include";
      },
    });
    const consume = async () => {
      for await (const _entry of iterator) {
        // Complete the real walk so close-only failures occur at EOF.
      }
    };
    if (phase.startsWith("iterator-")) {
      expect((await iterator.next()).value).toMatchObject({ kind: "file", size: 5 });
      if (phase === "iterator-return") {
        await expect(iterator.return()).rejects.toBe(closeFailure);
      } else {
        await expect(iterator.throw(primaryFailure)).rejects.toMatchObject({
          name: "SuppressedError", error: closeFailure, suppressed: primaryFailure,
        });
      }
    } else if (phase === "close-only") {
      await expect(consume()).rejects.toBe(closeFailure);
    } else {
      await expect(consume()).rejects.toMatchObject({
        name: "SuppressedError",
        error: closeFailure,
        suppressed: phase === "setup-error" ? { code: "path-mismatch", cause: primaryFailure } : primaryFailure,
      });
    }
    await iterator.return();
    expect(closeAttempts).toBe(1);
  },
);
