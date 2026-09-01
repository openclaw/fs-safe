import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __setFsSafeTestHooksForTest(); vi.restoreAllMocks(); });

it.each(["missing", "unlinked", "replacement"])("charges every discarded %s snapshot to retry and deadline limits", async (kind) => {
  for (const deadline of [false, true]) {
    const capability = await root(await tempRoot("sidecar-snapshot-budget-"));
    const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
    const manager = createFileLockManager(`snapshot-budget:${target}`);
    const create = vi.spyOn(capability, "create");
    const open = capability.open.bind(capability);
    const descriptors: FileHandle[] = [];
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(capability, "open").mockImplementation(async (...args) => {
      if (kind === "missing") {
        await fs.unlink(lockPath);
        now += 10;
      } else {
        __setFsSafeTestHooksForTest({ async afterOpen(candidate, handle) {
          if (candidate !== lockPath) return;
          __setFsSafeTestHooksForTest();
          descriptors.push(handle);
          await fs.unlink(lockPath);
          if (kind === "replacement") await fs.writeFile(lockPath, '{"owner":"replacement"}');
          now += 10;
        } });
      }
      return await open(...args);
    });
    await expect(manager.acquire(target, {
      lockRoot: capability,
      payload: async () => { await fs.writeFile(lockPath, '{"owner":"other"}'); return {}; },
      retry: { retries: 2, minTimeout: 0, maxTimeout: 0 },
      ...(deadline ? { timeoutMs: 10 } : {}),
    })).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(create).toHaveBeenCalledTimes(deadline ? 1 : 3);
    expect(descriptors.every((handle) => handle.fd === -1)).toBe(true);
    expect(manager.heldEntries()).toEqual([]);
    if (kind === "replacement") await expect(fs.readFile(lockPath, "utf8")).resolves.toContain("replacement");
    vi.restoreAllMocks();
  }
});
