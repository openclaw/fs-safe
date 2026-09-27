import { expect, it, vi } from "vitest";
import { createRenameWriter } from "../scripts/watch-stress/rename-writer.mjs";

it.each(["EPERM", "EBUSY", "EACCES"])("retries Windows %s and records recovery", async code => {
  const failure = Object.assign(new Error("sharing conflict"), { code });
  const rename = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const wait = vi.fn().mockResolvedValue(undefined);
  const writer = createRenameWriter({ platform: "win32", rename, wait });
  await writer.rename("parent", "moved");
  expect(rename.mock.calls).toEqual([["parent", "moved"], ["parent", "moved"]]);
  expect(wait.mock.calls).toEqual([[5]]);
  expect(writer.metrics).toEqual({ renameRetries: 1, renameExhaustedRetries: 0 });
});

it("bounds Windows retries and rethrows the final error on exhaustion", async () => {
  const failure = Object.assign(new Error("still pinned"), { code: "EPERM" });
  const rename = vi.fn().mockRejectedValue(failure), wait = vi.fn().mockResolvedValue(undefined);
  const writer = createRenameWriter({ platform: "win32", rename, wait });
  await expect(writer.rename("parent", "moved")).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledTimes(10);
  expect(wait.mock.calls.flat()).toEqual([5, 10, 20, 40, 80, 100, 100, 100, 100]);
  expect(writer.metrics).toEqual({ renameRetries: 9, renameExhaustedRetries: 1 });
});

it.each([["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"], ["win32", "EIO"]])(
  "does not retry %s %s", async (platform, code) => {
    const failure = Object.assign(new Error("rename failed"), { code });
    const rename = vi.fn().mockRejectedValue(failure), wait = vi.fn();
    const writer = createRenameWriter({ platform, rename, wait });
    await expect(writer.rename("parent", "moved")).rejects.toBe(failure);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(writer.metrics).toEqual({ renameRetries: 0, renameExhaustedRetries: 0 });
  },
);

it("does not delay successful renames and keeps independent writer counters", async () => {
  const wait = vi.fn(), rename = vi.fn().mockResolvedValue(undefined);
  const first = createRenameWriter({ platform: "win32", rename, wait });
  const second = createRenameWriter({ platform: "win32", rename, wait });
  await first.rename("parent", "moved");
  expect(wait).not.toHaveBeenCalled();
  first.metrics.renameRetries++;
  expect(second.metrics).toEqual({ renameRetries: 0, renameExhaustedRetries: 0 });
});
