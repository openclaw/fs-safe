import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import { inspectPathPermissions } from "../src/permissions.js";
import { inspectWindowsAcl } from "../src/permissions-windows.js";
import { readSecureFile } from "../src/secure-file.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const ENV = { SystemRoot: "C:\\Windows" };
const { tempRoot } = useRealTempDirs();

function trapCounter(): {
  count(): number;
  trap(): never;
} {
  let calls = 0;
  return {
    count: () => calls,
    trap: () => {
      calls += 1;
      throw new Error("hostile stderr hook executed");
    },
  };
}

async function targetFixture(prefix: string): Promise<string> {
  const root = await tempRoot(prefix);
  const target = path.join(root, "secret.json");
  await fs.writeFile(target, "PRIVATE_FILE_CONTENT", { mode: 0o600 });
  return target;
}

async function inspectStderrThroughBothRoutes(target: string, stderr: unknown) {
  const cause = Object.assign(new Error("command failed"), {
    code: 5,
    killed: false,
    signal: null,
    stderr,
    stdout: "PRIVATE_STDOUT",
  });
  const exec = vi.fn(async () => { throw cause; });
  const advanced = await inspectWindowsAcl("C:\\fixture", { env: ENV, exec });
  const pathname = await inspectPathPermissions(target, {
    platform: "win32",
    env: ENV,
    exec,
  });
  return { advanced, pathname, cause, exec };
}

function expectStderrResult(
  result: Awaited<ReturnType<typeof inspectStderrThroughBothRoutes>>,
  expected: string,
): void {
  expect(result.advanced).toMatchObject({
    ok: false,
    error: "Error: command failed",
    errorDetail: {
      exitCode: 5,
      timedOut: false,
      signal: null,
      stderr: expected,
    },
  });
  expect(result.pathname).toMatchObject({
    ok: true,
    source: "unknown",
    ownerError: "Error: command failed",
    errorDetail: {
      exitCode: 5,
      timedOut: false,
      signal: null,
      stderr: expected,
    },
  });
  expect(result.advanced.errorCause).toBe(result.cause);
  expect(result.pathname.errorCause).toBe(result.cause);
  expect(result.exec).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result.advanced.errorDetail)).not.toContain("PRIVATE_STDOUT");
}

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

describe("Windows owner stderr intrinsic snapshots", () => {
  it.each([
    {
      name: "ordinary proxy prototype",
      create: () => {
        const counter = trapCounter();
        const prototype = new Proxy({}, {
          get: counter.trap,
          getOwnPropertyDescriptor: counter.trap,
          getPrototypeOf: counter.trap,
          has: counter.trap,
          ownKeys: counter.trap,
        });
        return {
          value: Object.create(prototype),
          untouched: () => expect(counter.count()).toBe(0),
        };
      },
    },
    {
      name: "revoked proxy prototype",
      create: () => {
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        return { value: Object.create(revocable.proxy), untouched: () => {} };
      },
    },
  ])("ignores a non-byte stderr object with $name", async ({ create }) => {
    const target = await targetFixture("fs-safe-owner-stderr-object-");
    const { value, untouched } = create();
    const result = await inspectStderrThroughBothRoutes(target, value);

    expectStderrResult(result, "");
    untouched();
  });

  it("reads real Buffer bytes without touching hostile own compatibility hooks", async () => {
    const target = await targetFixture("fs-safe-owner-stderr-own-");
    const counter = trapCounter();
    const stderr = Buffer.from("original bytes\n");
    for (const name of ["length", "utf8Slice", "buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(stderr, name, { configurable: true, get: counter.trap });
    }

    const result = await inspectStderrThroughBothRoutes(target, stderr);

    expectStderrResult(result, "original bytes\\u000a");
    expect(counter.count()).toBe(0);
  });

  it.each([
    {
      name: "null prototype",
      alter: (value: Buffer, _trap: () => never) => Object.setPrototypeOf(value, null),
    },
    {
      name: "ordinary proxy prototype",
      alter: (value: Buffer, trap: () => never) => {
        const handler: ProxyHandler<object> = {};
        const prototype = new Proxy({}, handler);
        Object.setPrototypeOf(value, prototype);
        Object.assign(handler, {
          get: trap,
          getOwnPropertyDescriptor: trap,
          getPrototypeOf: trap,
          has: trap,
          ownKeys: trap,
        });
      },
    },
    {
      name: "revoked proxy prototype",
      alter: (value: Buffer, _trap: () => never) => {
        const revocable = Proxy.revocable({}, {});
        Object.setPrototypeOf(value, revocable.proxy);
        revocable.revoke();
      },
    },
  ])("reads real Buffer bytes with a $name", async ({ alter }) => {
    const target = await targetFixture("fs-safe-owner-stderr-prototype-");
    const counter = trapCounter();
    const stderr = Buffer.from("prototype safe\n");
    Object.defineProperties(stderr, {
      [Symbol.iterator]: { configurable: true, get: counter.trap },
      constructor: { configurable: true, get: counter.trap },
    });
    alter(stderr, counter.trap);

    const result = await inspectStderrThroughBothRoutes(target, stderr);

    expectStderrResult(result, "prototype safe\\u000a");
    expect(counter.count()).toBe(0);
  });

  it("returns an empty bounded detail for a detached Uint8Array", async () => {
    const target = await targetFixture("fs-safe-owner-stderr-detached-");
    const stderr = new Uint8Array([100, 101, 116, 97, 99, 104, 101, 100]);
    const backing = stderr.buffer as ArrayBuffer;
    structuredClone(backing, { transfer: [backing] });

    const result = await inspectStderrThroughBothRoutes(target, stderr);

    expectStderrResult(result, "");
  });

  it.each([
    {
      name: "ordinary Buffer",
      create: () => Buffer.from("buffer denied\n"),
      expected: "buffer denied\\u000a",
    },
    {
      name: "nonzero-offset Buffer",
      create: () => Buffer.from("__offset denied\n__").subarray(2, -2),
      expected: "offset denied\\u000a",
    },
    {
      name: "genuine Uint8Array",
      create: () => new Uint8Array(Buffer.from("uint8 denied\n")),
      expected: "uint8 denied\\u000a",
    },
    {
      name: "UTF-8 BOM",
      create: () => Buffer.from([0xef, 0xbb, 0xbf, 0x62, 0x6f, 0x6d]),
      expected: "\ufeffbom",
    },
    {
      name: "malformed UTF-8",
      create: () => Buffer.from([0xc3, 0x28]),
      expected: "�(",
    },
    {
      name: "control bytes",
      create: () => Buffer.from([0x00, 0x0a, 0x1b, 0x7f, 0xc2, 0x80]),
      expected: "\\u0000\\u000a\\u001b\\u007f\\u0080",
    },
    {
      name: "empty Buffer",
      create: () => Buffer.alloc(0),
      expected: "",
    },
    {
      name: "oversized Buffer",
      create: () => Buffer.alloc(1601, 0x61),
      expected: `${"a".repeat(399)}…`,
    },
  ])("decodes and bounds $name with exact diagnostics", async ({ create, expected }) => {
    const target = await targetFixture("fs-safe-owner-stderr-bytes-");

    const result = await inspectStderrThroughBothRoutes(target, create());

    expectStderrResult(result, expected);
    expect(expected.length).toBeLessThanOrEqual(400);
  });

  itPosix("keeps a poisoned Buffer cause exact while secure read closes before content access", async () => {
    const target = await targetFixture("fs-safe-owner-stderr-secure-");
    const counter = trapCounter();
    const stderr = Buffer.from("secure read denied\n");
    for (const name of ["length", "utf8Slice", "buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(stderr, name, { configurable: true, get: counter.trap });
    }
    const cause = Object.assign(new Error("command failed"), {
      code: 5,
      killed: false,
      signal: null,
      stderr,
    });
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
      details?: { stderr?: string };
    };

    expect(failure.code).toBe("permission-unverified");
    expect(failure.category).toBe("operational");
    expect(failure.cause).toBe(cause);
    expect(failure.details?.stderr).toBe("secure read denied\\u000a");
    expect(read).toBeDefined();
    expect(close).toBeDefined();
    expect(read!).not.toHaveBeenCalled();
    expect(close!).toHaveBeenCalledTimes(1);
    expect(`${failure.message}${JSON.stringify(failure.details)}`).not.toContain(
      "PRIVATE_FILE_CONTENT",
    );
    expect(counter.count()).toBe(0);
  });
});
