import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("Windows sidecar lock denials", () => {
  // Windows denies access to a lock file while a just-unlinked directory entry is
  // still being torn down. Both touch points below observed it in CI as EPERM.
  const denial = (lockPath: string) =>
    Object.assign(new Error(`EPERM: operation not permitted, open '${lockPath}'`), {
      code: "EPERM",
      errno: -4048,
      syscall: "open",
      path: lockPath,
    });

  it("keeps the lock-file EPERM when no retry is left", async () => {
    // Classifying the denial as contention must not cost the caller the
    // diagnosis: with no retry budget the original EPERM has to survive
    // instead of being replaced by the loop's timeout error.
    const base = await fsp.realpath(await tempRoot("fs-safe-sidecar-eperm-exhausted-"));
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    configureFsSafeNative({ mode: "off" });
    const realOpen = fsp.open.bind(fsp) as typeof fsp.open;

    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (args[0] === lockPath && args[1] === "wx") throw denial(lockPath);
      return await realOpen(...args);
    }) as typeof fsp.open);

    await expect(
      acquireFileLock(targetPath, {
        managerKey: `eperm-exhausted-${Date.now()}-${Math.random()}`,
        staleMs: 60_000,
        timeoutMs: 1_000,
        retry: { retries: 0 },
        payload: async () => ({ pid: process.pid }),
      }),
    ).rejects.toMatchObject({ code: "EPERM", path: lockPath });
  });

  it("propagates an EPERM that names the lock parent", async () => {
    // A denial from setup names the parent. Only the teardown window on the
    // lock file itself is contention; a parent denial must reach the caller.
    const base = await fsp.realpath(await tempRoot("fs-safe-sidecar-eperm-parent-"));
    const targetPath = path.join(base, "state.json");
    configureFsSafeNative({ mode: "off" });
    const realOpen = fsp.open.bind(fsp) as typeof fsp.open;
    let payloadCalls = 0;

    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (args[0] === `${targetPath}.lock` && args[1] === "wx") throw denial(base);
      return await realOpen(...args);
    }) as typeof fsp.open);

    await expect(
      acquireFileLock(targetPath, {
        managerKey: `eperm-parent-${Date.now()}-${Math.random()}`,
        staleMs: 60_000,
        timeoutMs: 1_000,
        retry: { retries: 0 },
        payload: async () => {
          payloadCalls += 1;
          return { pid: process.pid };
        },
      }),
    ).rejects.toMatchObject({ code: "EPERM", path: base });
    expect(payloadCalls).toBe(1);
  });

  it("propagates an EPERM raised outside the lock file", async () => {
    // Only the lock-file create and snapshot read see the teardown window. An
    // EPERM from the caller's payload must reach the caller unchanged instead
    // of being retried, which would rerun the callback and hide the error.
    const base = await fsp.realpath(await tempRoot("fs-safe-sidecar-eperm-payload-"));
    const targetPath = path.join(base, "state.json");
    configureFsSafeNative({ mode: "off" });
    let payloadCalls = 0;

    await expect(
      acquireFileLock(targetPath, {
        managerKey: `eperm-payload-${Date.now()}-${Math.random()}`,
        staleMs: 60_000,
        timeoutMs: 1_000,
        retry: { retries: 0 },
        payload: async () => {
          payloadCalls += 1;
          throw denial(`${targetPath}.lock`);
        },
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(payloadCalls).toBe(1);
  });

  it("retries an exclusive create denied mid-teardown", async () => {
    const base = await fsp.realpath(await tempRoot("fs-safe-sidecar-eperm-create-"));
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    configureFsSafeNative({ mode: "off" });
    const realOpen = fsp.open.bind(fsp) as typeof fsp.open;
    let injected = 0;
    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (args[0] === lockPath && args[1] === "wx" && injected === 0) {
        injected += 1;
        throw denial(lockPath);
      }
      return await realOpen(...args);
    }) as typeof fsp.open);

    const lock = await acquireFileLock(targetPath, {
      managerKey: `eperm-create-${Date.now()}-${Math.random()}`,
      staleMs: 60_000,
      timeoutMs: 1_000,
      retry: { minTimeout: 1, maxTimeout: 2 },
      payload: async () => ({ pid: process.pid }),
    });
    await lock.release();

    expect(injected).toBe(1);
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a contended snapshot read denied mid-teardown", async () => {
    const base = await fsp.realpath(await tempRoot("fs-safe-sidecar-eperm-read-"));
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    configureFsSafeNative({ mode: "off" });
    await fsp.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    const realReadFile = fsp.readFile.bind(fsp) as typeof fsp.readFile;
    let injected = 0;
    vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      if (args[0] === lockPath && injected === 0) {
        injected += 1;
        // The holder's unlink lands while the reader is being denied.
        await fsp.rm(lockPath, { force: true });
        throw denial(lockPath);
      }
      return await realReadFile(...args);
    }) as typeof fsp.readFile);

    const lock = await acquireFileLock(targetPath, {
      managerKey: `eperm-read-${Date.now()}-${Math.random()}`,
      staleMs: 60_000,
      timeoutMs: 1_000,
      retry: { minTimeout: 1, maxTimeout: 2 },
      payload: async () => ({ pid: process.pid }),
    });
    await lock.release();

    expect(injected).toBe(1);
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
