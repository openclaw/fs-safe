import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "sorted snapshot", order: "sorted", maxEntries: undefined },
  { name: "sorted batches", order: "sorted", maxEntries: 16 },
  { name: "filesystem", order: "filesystem", maxEntries: undefined },
] as const)("rejects cancellation from a synchronous $name filter before yielding", async ({ order, maxEntries }) => {
  const directory = await tempRoot("fs-safe-walk-filter-abort-");
  await fs.mkdir(path.join(directory, "child"));
  await fs.writeFile(path.join(directory, "child", "value"), "value");
  const capability = await root(directory);
  const controller = new AbortController();
  const closed = vi.fn();
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const handle = await opendir(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed(); });
    return handle;
  });
  const filter = vi.fn(() => { controller.abort(); return "include" as const; });
  const iterator = capability.walk("", {
    order, maxEntries, symlinkPolicy: "skip", signal: controller.signal,
    onDirectoryError: "skip-and-report", entryFilter: filter,
  });
  try {
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
    expect(filter).toHaveBeenCalledTimes(1);
    if (order === "filesystem") expect(closed).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  } finally { await iterator.return(); }
});
