import { describe, expect, it, vi } from "vitest";
import { mapReleasePackages, RELEASE_PACKAGE_CONCURRENCY } from "../scripts/release-package-batches.mjs";

describe("release package batches", () => {
  it("bounds concurrency at four and preserves order across eleven packages", async () => {
    const pending = new Map<number, (value: number) => void>();
    const started: number[] = [];
    const result = mapReleasePackages(Array.from({ length: 11 }, (_, index) => index), (index: number) => {
      started.push(index);
      return new Promise<number>((resolve) => pending.set(index, resolve));
    });
    expect(RELEASE_PACKAGE_CONCURRENCY).toBe(4);
    expect(started).toEqual([0, 1, 2, 3]);
    for (const index of [3, 2, 1]) pending.get(index)!(index);
    await Promise.resolve();
    expect(started).toHaveLength(4);
    pending.get(0)!(0);
    await vi.waitFor(() => expect(started).toHaveLength(8));
    for (const index of [7, 6, 5, 4]) pending.get(index)!(index);
    await vi.waitFor(() => expect(started).toHaveLength(11));
    for (const index of [10, 9, 8]) pending.get(index)!(index);
    await expect(result).resolves.toEqual(Array.from({ length: 11 }, (_, index) => index));
  });

  it.each(["throw", "reject"])("settles the failed batch without starting later packages (%s)", async (kind) => {
    const failure = new Error("signature mismatch");
    let finish!: () => void;
    const started: number[] = [];
    const operation = mapReleasePackages([0, 1, 2, 3, 4], (index: number) => {
      started.push(index);
      if (index === 0) {
        if (kind === "throw") throw failure;
        return Promise.reject(failure);
      }
      if (index === 3) return new Promise<void>((resolve) => { finish = resolve; });
    });
    let settled = false;
    const rejection = expect(operation).rejects.toBe(failure).then(() => { settled = true; });
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(settled).toBe(false);
    finish();
    await rejection;
    expect(started).toEqual([0, 1, 2, 3]);
  });
});
