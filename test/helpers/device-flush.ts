import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { vi } from "vitest";

// Only for semantics tests: hosted Windows device flushes can stall for seconds.
// Keep namespace and descriptor operations real; durability suites own sync proof.
// Call before installing other spies, and restoreAllMocks in afterEach before cleanup.
export async function skipDeviceFlushes(): Promise<void> {
  const probe = await fs.open(process.execPath, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  vi.spyOn(prototype, "sync").mockResolvedValue();
  vi.spyOn(fsSync, "fsyncSync").mockImplementation(() => {});
}
