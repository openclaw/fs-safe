import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateGzipBufferTail, validateGzipContainerTail } from "../src/archive-gzip-tail.js";
import { completeGzip } from "./helpers/archive-gzip-container.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

it.each([0, 1, 65535, 65536, 65537, 131089])("accepts %i zero suffix bytes in memory and staged files", async (size) => {
  const base = await tempRoot("fs-safe-gzip-tail-zero-");
  const file = path.join(base, "input.tgz");
  const bytes = Buffer.concat([completeGzip, Buffer.alloc(size)]);
  await fs.writeFile(file, bytes);
  await expect(validateGzipBufferTail(bytes, completeGzip.length)).resolves.toBeUndefined();
  await expect(validateGzipContainerTail(file, completeGzip.length)).resolves.toBeUndefined();
});

it.each([0, 65535, 65536, 131088])("rejects nonzero suffix byte %i in memory and staged files", async (offset) => {
  const base = await tempRoot("fs-safe-gzip-tail-nonzero-");
  const file = path.join(base, "input.tgz");
  const bytes = Buffer.concat([completeGzip, Buffer.alloc(131089)]);
  bytes[completeGzip.length + offset] = 255;
  await fs.writeFile(file, bytes);
  await expect(validateGzipBufferTail(bytes, completeGzip.length)).rejects.toMatchObject({ code: "archive-header-invalid" });
  await expect(validateGzipContainerTail(file, completeGzip.length)).rejects.toMatchObject({ code: "archive-header-invalid" });
});

it("validates only bytes returned by short staged suffix reads", async () => {
  const base = await tempRoot("fs-safe-gzip-tail-short-");
  const file = path.join(base, "input.tgz");
  await fs.writeFile(file, Buffer.concat([completeGzip, Buffer.alloc(19)]));
  const handle = await fs.open(file, "r");
  const originalRead = handle.read.bind(handle);
  const read = vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
    buffer.fill(255);
    return await originalRead(buffer, offset, Math.min(length, 3), position);
  });
  vi.spyOn(fs, "open").mockResolvedValue(handle);
  await expect(validateGzipContainerTail(file, completeGzip.length)).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledTimes(7);
  await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
});

it("lets cancellation interrupt an in-memory suffix scan between bounded windows", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel buffered gzip padding scan");
  const bytes = Buffer.concat([completeGzip, Buffer.alloc(131089)]);
  setImmediate(() => controller.abort(reason));
  await expect(validateGzipBufferTail(bytes, completeGzip.length, controller.signal)).rejects.toBe(reason);
});

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
