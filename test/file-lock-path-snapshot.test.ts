import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFileLockManager, type FileLockAcquireOptions } from "../src/file-lock.js";

const sidecar = vi.hoisted(() => ({
  acquire: vi.fn(async (_options: Record<PropertyKey, unknown>) => undefined),
  withLock: vi.fn(async (_options: Record<PropertyKey, unknown>, _run: () => Promise<unknown>) => undefined),
  drain: vi.fn(),
  reset: vi.fn(),
  heldEntries: vi.fn(),
}));

vi.mock("../src/sidecar-lock.js", () => ({
  createSidecarLockManager: () => sidecar,
}));

beforeEach(() => vi.clearAllMocks());

describe("file lock wrapper pathname snapshots", () => {
  it.each(["acquire", "withLock"] as const)(
    "%s reads named getters once without object-rest exclusions on supported Node versions",
    async (route) => {
      for (const storage of ["own-enumerable", "own-hidden", "inherited"] as const) {
        for (const lockPath of ["locks/state.lock", undefined]) {
          vi.clearAllMocks();
          const reads: Record<string, number> = {};
          const once = <T>(name: string, value: T) => () => {
            reads[name] = (reads[name] ?? 0) + 1;
            if (reads[name] !== 1) throw new Error(`${name} read more than once`);
            return value;
          };
          const fields = {
            managerKey: { enumerable: storage === "own-enumerable", get: once("managerKey", "ignored") },
            lockPath: { enumerable: storage === "own-enumerable", get: once("lockPath", lockPath) },
          };
          const options = (storage === "inherited"
            ? Object.create(Object.defineProperties({}, fields))
            : Object.defineProperties({}, fields)) as FileLockAcquireOptions<Record<string, unknown>>;
          const payload = vi.fn(() => ({ ready: true }));
          const retry = { retries: 0 };
          const marker = Symbol("caller state");
          const protoValue = { retained: true };
          Object.defineProperties(options, {
            payload: { enumerable: true, get: once("payload", payload) },
            retry: { enumerable: true, get: once("retry", retry) },
            [marker]: { enumerable: true, value: "symbol state" },
            ["__proto__"]: { enumerable: true, value: protoValue },
            hidden: { get: () => { throw new Error("unused hidden getter"); } },
          });
          const manager = createFileLockManager("pathname-snapshot");
          const run = vi.fn(async () => "result");
          if (route === "acquire") await manager.acquire("state.json", options);
          else await manager.withLock("state.json", options, run);

          const received = route === "acquire"
            ? sidecar.acquire.mock.calls[0]?.[0]
            : sidecar.withLock.mock.calls[0]?.[0];
          expect(received).toBeDefined();
          if (!received) throw new Error("expected sidecar options");
          expect(reads).toEqual({ managerKey: 1, lockPath: 1, payload: 1, retry: 1 });
          expect(received).toMatchObject({ targetPath: "state.json", payload, retry });
          expect(received.lockPath).toBe(lockPath);
          expect(Object.hasOwn(received, "lockPath")).toBe(lockPath !== undefined);
          expect(Object.hasOwn(received, "managerKey")).toBe(false);
          expect(Object.hasOwn(received, "hidden")).toBe(false);
          expect(Object.getPrototypeOf(received)).toBe(Object.prototype);
          expect(Object.getOwnPropertyDescriptor(received, "__proto__")?.value).toBe(protoValue);
          expect(received[marker]).toBe("symbol state");
          expect(payload).not.toHaveBeenCalled();
          expect(run).not.toHaveBeenCalled();
          if (route === "withLock") expect(sidecar.withLock.mock.calls[0]?.[1]).toBe(run);
        }
      }
    },
  );
});
