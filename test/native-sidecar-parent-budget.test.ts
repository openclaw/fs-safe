import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { createNativeExclusiveFile } from "../src/native-operations.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe("native raw sidecar parent lifecycle", () => {
  it.each([false, true])("keeps parent metadata synchronous and closes it on conflict=%s", async (conflict) => {
    const directory = await tempRoot("fs-safe-native-lock-parent-");
    const file = path.join(directory, "state.lock");
    if (conflict) fs.writeFileSync(file, "other owner");
    const openBeneath = vi.fn((parent: number, name: string, flags: number) => {
      expect(fs.fstatSync(parent).isDirectory()).toBe(true);
      return { fd: fs.openSync(path.join(directory, name), flags, 0o600) };
    });
    __setNativeLoaderForTest(() => ({ openBeneath, closeOwnedFd: fs.closeSync } as unknown as NativeBinding));
    configureFsSafeNative({ mode: "require" });
    const asyncOpen = vi.spyOn(fsp, "open");
    const close = vi.spyOn(fs, "closeSync");
    if (conflict) {
      await expect(createNativeExclusiveFile(file, 0o600)).rejects.toMatchObject({ code: "EEXIST" });
      expect(fs.readFileSync(file, "utf8")).toBe("other owner");
    } else {
      const handle = await createNativeExclusiveFile(file, 0o600);
      expect(handle).toBeDefined();
      try {
        expect(close).toHaveBeenCalledTimes(1);
        await handle!.writeFile("ours");
        expect(fs.readFileSync(file, "utf8")).toBe("ours");
      } finally { await handle?.close(); }
    }
    expect(openBeneath).toHaveBeenCalledOnce();
    const parentFd = openBeneath.mock.calls[0]![0];
    expect(close.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
    expect(asyncOpen).not.toHaveBeenCalled();
  });
});
