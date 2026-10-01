import fs from "node:fs/promises";
import { expect, vi } from "vitest";
import { inspectPathPermissions } from "../../src/permissions.js";
import { inspectWindowsAcl } from "../../src/permissions-windows.js";
import { readSecureFile } from "../../src/secure-file.js";

const ENV = { SystemRoot: "C:\\Windows" };

export function createTrapCounter(message: string): {
  count: () => number;
  trap: () => never;
} {
  let calls = 0;
  return {
    count: () => calls,
    trap: () => {
      calls += 1;
      throw new Error(message);
    },
  };
}

export async function inspectThroughBothPublicRoutes(target: string, value: unknown) {
  const exec = vi.fn(async () => { throw value; });
  const advanced = await inspectWindowsAcl("C:\\fixture", { env: ENV, exec });
  const pathname = await inspectPathPermissions(target, {
    platform: "win32",
    env: ENV,
    exec,
  });
  return { advanced, pathname, exec };
}

export async function expectSecureReadRefusal(target: string, cause: unknown, secret: string) {
  const actualOpen = fs.open.bind(fs);
  let close: ReturnType<typeof vi.spyOn> | undefined;
  let read: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await actualOpen(...args);
    close = vi.spyOn(handle, "close");
    read = vi.spyOn(handle, "readFile");
    return handle;
  });

  const failure = await readSecureFile({
    filePath: target,
    inject: {
      platform: "win32",
      env: ENV,
      exec: async () => { throw cause; },
    },
  }).catch((error: unknown) => error) as Error & {
    cause?: unknown;
    category?: string;
    code?: string;
    details?: Record<string, unknown>;
  };

  expect(failure.code).toBe("permission-unverified");
  expect(failure.category).toBe("operational");
  expect(failure.cause).toBe(cause);
  expect(read).toBeDefined();
  expect(close).toBeDefined();
  expect(read!).not.toHaveBeenCalled();
  expect(close!).toHaveBeenCalledTimes(1);
  expect(`${failure.message}${JSON.stringify(failure.details)}`).not.toContain(secret);
  return failure;
}
