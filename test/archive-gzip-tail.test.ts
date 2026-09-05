import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateGzipContainerTail } from "../src/archive-gzip-tail.js";
import { completeGzip } from "./helpers/archive-gzip-container.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());
it("stops a cancelled suffix scan at its bounded read and closes the borrowed file", async () => {
  const base = await tempRoot("fs-safe-gzip-tail-cancel-");
  const file = path.join(base, "input.tgz");
  await fs.writeFile(file, Buffer.concat([completeGzip, Buffer.alloc(131072)]));
  const handle = await fs.open(file, "r");
  const originalRead = handle.read.bind(handle);
  const controller = new AbortController();
  const reason = new Error("cancel gzip padding scan");
  const read = vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof originalRead>) => {
    const result = await originalRead(...args);
    controller.abort(reason);
    return result;
  });
  vi.spyOn(fs, "open").mockResolvedValue(handle);
  await expect(validateGzipContainerTail(file, completeGzip.length, controller.signal)).rejects.toBe(reason);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]![2]).toBe(65536);
  await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
});
