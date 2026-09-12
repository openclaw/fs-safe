import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withExtractionDeadline } from "../src/archive-deadline.js";
import { readSecureFile } from "../src/secure-file.js";
import { sleep, withTimeout } from "../src/timing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const MAX_DELAY = 2 ** 31 - 1;
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
}

it("waits through multiple timer intervals before expiring", async () => {
  fakeTimers();
  const error = new Error("deadline reached");
  const createError = vi.fn(() => error);
  const result = withTimeout(new Promise(() => {}), MAX_DELAY * 2 + 25, { createError });
  const rejected = expect(result).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(MAX_DELAY * 2);
  expect(createError).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(24);
  expect(createError).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(createError).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the rearmed timer when the wrapped operation settles", async () => {
  fakeTimers();
  let finish!: (value: string) => void;
  const result = withTimeout(new Promise<string>((resolve) => { finish = resolve; }), MAX_DELAY + 50);
  await vi.advanceTimersByTimeAsync(MAX_DELAY);
  expect(vi.getTimerCount()).toBe(1);
  finish("done");
  await expect(result).resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);
});

it("honors a large sleep used by asynchronous retries", async () => {
  fakeTimers();
  const finished = vi.fn();
  const sleeping = sleep(MAX_DELAY + 2).then(finished);
  await vi.advanceTimersByTimeAsync(MAX_DELAY + 1);
  expect(finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await sleeping;
  expect(finished).toHaveBeenCalledTimes(1);
});

it("aborts an extraction only when its full large deadline elapses", async () => {
  fakeTimers();
  let signal!: AbortSignal;
  const result = withExtractionDeadline(MAX_DELAY + 20, "archive", async (deadline) => {
    signal = deadline.signal;
    return await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
  });
  const rejected = expect(result).rejects.toThrow(`archive timed out after ${MAX_DELAY + 20}ms`);
  await vi.advanceTimersByTimeAsync(MAX_DELAY + 19);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears a large extraction timer on successful completion", async () => {
  fakeTimers();
  await expect(withExtractionDeadline(Number.MAX_VALUE, "archive", async () => "done"))
    .resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a secure read open through an oversized timeout", async () => {
  const dir = await tempRoot("fs-safe-large-read-timeout-");
  const filePath = path.join(dir, "secret");
  await fs.writeFile(filePath, "secret bytes", { mode: 0o600 });
  const handle = await fs.open(filePath, "r");
  let finish!: (value: Buffer) => void;
  let reading!: () => void;
  const entered = new Promise<void>((resolve) => { reading = resolve; });
  const content = new Promise<Buffer>((resolve) => { finish = resolve; });
  vi.spyOn(fs, "open").mockResolvedValue(handle);
  vi.spyOn(handle, "readFile").mockImplementation(() => { reading(); return content; });
  const close = vi.spyOn(handle, "close");
  fakeTimers();
  const result = readSecureFile({ filePath, permissions: { allowInsecure: true }, io: { timeoutMs: MAX_DELAY + 20 } });
  // Attach rejection handling before ticking even against the broken implementation.
  const success = expect(result).resolves.toMatchObject({ buffer: Buffer.from("secret bytes") });
  try {
    await entered;
    await vi.advanceTimersByTimeAsync(MAX_DELAY + 19);
    expect(close).not.toHaveBeenCalled();
    finish(Buffer.from("secret bytes"));
    await success;
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    finish(Buffer.from("secret bytes"));
    await result.catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
});
