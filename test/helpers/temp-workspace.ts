import fsSync from "node:fs";
import { afterEach, beforeEach, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../../src/native-config.js";
import { __resetNativeLoaderForTest } from "../../src/native.js";
import { tempWorkspaceSync } from "../../src/temp.js";
import * as cleanup from "../../src/temp-cleanup.js";
import { useRealTempDirs } from "./vitest.js";

export function observeSyncOpen(observe: (args: Parameters<typeof fsSync.openSync>, fd: number) => void) {
  const open = fsSync.openSync.bind(fsSync);
  return vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
    const fd = open(...args);
    observe(args, fd);
    return fd;
  });
}

export function withUmask<T>(mode: number, run: () => T): T {
  const previous = process.umask(mode);
  try {
    return run();
  } finally {
    process.umask(previous);
  }
}

export function tempWorkspaceSyncWithUmask022(options: Parameters<typeof tempWorkspaceSync>[0]) {
  return withUmask(0o022, () => tempWorkspaceSync(options));
}

export function useWorkspaceFixture() {
  const fixture = useRealTempDirs();
  beforeEach(() => configureFsSafeNative({ mode: "off" }));
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup.__cleanupRegisteredTempPathsForTest();
    __resetNativeLoaderForTest();
    __resetFsSafeNativeConfigForTest();
  });
  return fixture;
}
