import { expect } from "vitest";
import type { root } from "../../src/root.js";
import type { createSidecarLockManager } from "../../src/sidecar-lock.js";

export type ManagerState<H = unknown> = {
  held: Map<string, H>;
  admissions: Map<string, object>;
};

export function managerState<H = unknown>(key: string): ManagerState<H> {
  const managers = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockManagers")) as Map<
    string,
    ManagerState<H>
  >;
  return managers.get(key)!;
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => { throw new Error("expected acquisition to reject"); },
    (error: unknown) => error,
  );
}

export function requiredNativeMode(): "off" | "require" {
  return process.env.FS_SAFE_NATIVE_MODE === "require" ? "require" : "off";
}

export async function freshProbe(
  manager: ReturnType<typeof createSidecarLockManager>,
  targetPath: string,
  lockRoot: Awaited<ReturnType<typeof root>> | undefined,
): Promise<void> {
  const probe = await manager.acquire({
    targetPath, lockRoot, staleMs: 30_000, timeoutMs: 0, retry: { retries: 0 },
    payload: async () => ({ owner: "probe" }),
  });
  expect(await probe.verifyStillHeld()).toBe(true);
  await probe.release();
}
