import type { Stats } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

function simulateWindows(): void {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
}

function exitCleanup(): void {
  const cleanup = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockCleanupHandler"));
  expect(cleanup).toBeTypeOf("function");
  cleanup();
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("lock exit identity", () => {
  async function holdLock(label: string) {
    const base = await tempRoot(`fs-safe-lock-exit-identity-${label}-`);
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-lock-exit-identity-${label}`);
    await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 60_000,
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
    });
    return { manager, lockPath };
  }

  it("deletes a lock when Windows reports a stable known identity", async () => {
    const { manager, lockPath } = await holdLock("known");
    try {
      simulateWindows();
      exitCleanup();
      expect(fsSync.existsSync(lockPath)).toBe(false);
    } finally {
      manager.reset();
    }
  });

  for (const observation of ["before", "descriptor", "after"] as const) {
    it.each(["dev", "ino"] as const)(`keeps a lock with unknown Windows ${observation} %s`, async (field) => {
      const { manager, lockPath } = await holdLock(`${observation}-${field}`);
      const realLstat = fsSync.lstatSync.bind(fsSync);
      const realOpen = fsSync.openSync.bind(fsSync);
      const realFstat = fsSync.fstatSync.bind(fsSync);
      let lockFd: number | undefined;
      let lockLstats = 0;
      let injected = false;
      const unknown = (stat: Stats): Stats => {
        injected = true;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { [field]: 0 });
      };
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = realLstat(...args) as Stats;
        if (String(args[0]) !== lockPath) return stat;
        lockLstats += 1;
        return (observation === "before" && lockLstats === 1)
          || (observation === "after" && lockLstats === 2) ? unknown(stat) : stat;
      });
      vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
        const fd = realOpen(...args);
        if (String(args[0]) === lockPath) lockFd = fd;
        return fd;
      });
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
        const stat = realFstat(...args) as Stats;
        return observation === "descriptor" && args[0] === lockFd ? unknown(stat) : stat;
      });
      const remove = vi.spyOn(fsSync, "rmSync");
      try {
        simulateWindows();
        exitCleanup();
        expect(injected).toBe(true);
        expect(remove.mock.calls.some(([candidate]) => String(candidate) === lockPath)).toBe(false);
        expect(fsSync.existsSync(lockPath)).toBe(true);
      } finally {
        manager.reset();
      }
    });
  }
});
