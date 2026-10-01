import type { FileHandle } from "node:fs/promises";
import { expect, vi } from "vitest";

export function observeOpenedHandle(filePath: string) {
  let handle: FileHandle | undefined;
  let close: ReturnType<typeof vi.spyOn> | undefined;
  let read: ReturnType<typeof vi.spyOn> | undefined;
  let readFile: ReturnType<typeof vi.spyOn> | undefined;
  return {
    hook(candidate: string, opened: FileHandle) {
      if (candidate !== filePath) return;
      handle = opened;
      close = vi.spyOn(opened, "close");
      read = vi.spyOn(opened, "read");
      readFile = vi.spyOn(opened, "readFile");
    },
    get handle() {
      return handle;
    },
    get close() {
      return close;
    },
    get read() {
      return read;
    },
    get readFile() {
      return readFile;
    },
  };
}

export function expectClosedWithoutReading(observed: ReturnType<typeof observeOpenedHandle>): void {
  expect(observed.handle?.fd).toBe(-1);
  expect(observed.close).toHaveBeenCalledTimes(1);
  expect(observed.read).not.toHaveBeenCalled();
  expect(observed.readFile).not.toHaveBeenCalled();
}
