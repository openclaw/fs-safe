import { afterEach, expect, it, vi } from "vitest";
import { observe } from "../scripts/watch-stress/oracle.mjs";

afterEach(() => vi.restoreAllMocks());

function observerFor(readBytes: () => Promise<Buffer>, present: () => boolean) {
  let invalidate: (event: object) => void = () => {};
  const capability = {
    list: async () => present() ? [{ name: "file", isFile: true }] : [],
    readBytes,
  };
  const observer = observe({ capability }, {}, (_root, options) => {
    invalidate = options.onInvalidate;
    return { close: async () => {} };
  });
  observer.cache.set("file", "stale");
  return { observer, invalidate: (detailed: boolean) => invalidate({ reason: "reconcile",
    ...(detailed ? { changes: [{ path: "file", type: "content" }] } : {}),
  }) };
}

it.each(["EPERM", "EBADF"].flatMap(code => [false, true].map(detailed => ({ code, detailed }))))(
  "preserves a Windows deleted-file invalidation ($code, detailed=$detailed)", async ({ code, detailed }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let present = true;
    const read = vi.fn(async () => {
      present = false;
      throw Object.assign(new Error("deleted while open"), { code, syscall: "realpath" });
    });
    const { observer, invalidate } = observerFor(read, () => present);
    try {
      invalidate(detailed);
      await observer.flush();
      expect(observer.cache.has("file")).toBe(false);
      expect(observer.metrics.consumerReadErrors).toBe(1);
      expect(observer.metrics.invalidations).toBe(1);
      expect(read).toHaveBeenCalledTimes(1);
    } finally { await observer.close(); }
  },
);

it.each([["linux", "EPERM", "realpath"], ["win32", "EPERM", "open"], ["win32", "EACCES", "realpath"]])(
  "still rejects an unexpected read error (%s %s %s)", async (platform, code, syscall) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    const failure = Object.assign(new Error("unexpected refusal"), { code, syscall });
    const read = vi.fn(async () => { throw failure; });
    const { observer, invalidate } = observerFor(read, () => true);
    invalidate(true);
    await expect(observer.flush()).rejects.toBe(failure);
    await expect(observer.close()).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
  },
);
