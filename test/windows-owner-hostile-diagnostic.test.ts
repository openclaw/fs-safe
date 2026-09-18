import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PermissionCommandError,
  formatCaughtPermissionFailure,
} from "../src/permission-exec.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  inspectPathPermissions,
  inspectWindowsAcl,
} from "../src/permissions.js";
import { readSecureFile } from "../src/secure-file.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const ENV = { SystemRoot: "C:\\Windows" };
const { tempRoot } = useRealTempDirs();

type HostileFailure = {
  name: string;
  create(): { value: unknown; untouched?(): void };
};

function trapCounter(): {
  count: () => number;
  trap: () => never;
} {
  let calls = 0;
  return {
    count: () => calls,
    trap: () => {
      calls += 1;
      throw new Error("hostile diagnostic hook executed");
    },
  };
}

const HOSTILE_FAILURES: HostileFailure[] = [
  {
    name: "coercion hooks",
    create: () => {
      const counter = trapCounter();
      const value = Object.create(null);
      Object.defineProperties(value, {
        [Symbol.toPrimitive]: { value: counter.trap },
        toString: { value: counter.trap },
        valueOf: { value: counter.trap },
      });
      return { value, untouched: () => expect(counter.count()).toBe(0) };
    },
  },
  {
    name: "throwing name and message accessors",
    create: () => {
      const counter = trapCounter();
      const value = Object.create(Error.prototype);
      Object.defineProperties(value, {
        name: { get: counter.trap },
        message: { get: counter.trap },
      });
      return { value, untouched: () => expect(counter.count()).toBe(0) };
    },
  },
  {
    name: "object-valued message",
    create: () => {
      const counter = trapCounter();
      const message = Object.create(null);
      Object.defineProperty(message, Symbol.toPrimitive, { value: counter.trap });
      const value = Object.create(null);
      Object.defineProperty(value, "message", { value: message });
      return { value, untouched: () => expect(counter.count()).toBe(0) };
    },
  },
  {
    name: "null-prototype object",
    create: () => ({ value: Object.create(null) }),
  },
  {
    name: "function",
    create: () => ({ value: function customDiagnosticFailure() {} }),
  },
  {
    name: "ordinary proxy",
    create: () => {
      const counter = trapCounter();
      const value = new Proxy(Object.assign(new Error("hidden"), {
        code: 5,
        stderr: "hidden stderr",
      }), {
        get: counter.trap,
        getOwnPropertyDescriptor: counter.trap,
        getPrototypeOf: counter.trap,
        has: counter.trap,
        ownKeys: counter.trap,
      });
      return { value, untouched: () => expect(counter.count()).toBe(0) };
    },
  },
  {
    name: "revoked proxy",
    create: () => {
      const revocable = Proxy.revocable(new Error("hidden"), {});
      revocable.revoke();
      return { value: revocable.proxy };
    },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

async function inspectThroughBothPublicRoutes(target: string, value: unknown) {
  const exec = vi.fn(async () => { throw value; });
  const advanced = await inspectWindowsAcl("C:\\fixture", { env: ENV, exec });
  const pathname = await inspectPathPermissions(target, {
    platform: "win32",
    env: ENV,
    exec,
  });
  return { advanced, pathname, exec };
}

function expectBoundedFailure(result: {
  error?: string;
  errorCause?: unknown;
}, value: unknown): void {
  expect(Object.hasOwn(result, "errorCause")).toBe(true);
  expect(result.errorCause).toBe(value);
  expect(typeof result.error).toBe("string");
  if (value === "") {
    expect(result.error).toBe("");
  } else {
    expect(result.error!.length).toBeGreaterThan(0);
  }
  expect(result.error!.length).toBeLessThanOrEqual(400);
  expect(result.error).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
}

describe("Windows owner caught-failure diagnostics", () => {
  it.each(HOSTILE_FAILURES)("fails closed without invoking $name", async ({ create }) => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-owner-hostile-");
    const target = path.join(root, "secret.json");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const { value, untouched } = create();

    const { advanced, pathname, exec } = await inspectThroughBothPublicRoutes(target, value);

    expect(advanced).toMatchObject({ ok: false, entries: [] });
    expect(pathname).toMatchObject({ ok: true, source: "unknown" });
    expectBoundedFailure(advanced, value);
    expect(Object.hasOwn(pathname, "errorCause")).toBe(true);
    expectBoundedFailure({
      error: pathname.ownerError,
      errorCause: pathname.errorCause,
    }, value);
    expect(advanced.errorDetail).toBeUndefined();
    expect(pathname.errorDetail).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
    untouched?.();
  });

  it.each([
    undefined,
    null,
    false,
    true,
    0,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    12n,
    "",
    "plain rejection",
    Symbol("symbolic rejection"),
  ])("formats primitive rejection %s without escaping the public inspector", async (value) => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-owner-primitive-");
    const target = path.join(root, "secret.json");
    await fs.writeFile(target, "secret", { mode: 0o600 });

    const { advanced, pathname } = await inspectThroughBothPublicRoutes(target, value);

    expect(advanced.ok).toBe(false);
    expect(pathname.source).toBe("unknown");
    expectBoundedFailure(advanced, value);
    expect(Object.hasOwn(pathname, "errorCause")).toBe(true);
    expectBoundedFailure({
      error: pathname.ownerError,
      errorCause: pathname.errorCause,
    }, value);
  });

  it("formats primitives without calling their mutable prototype methods", () => {
    const values = [null, undefined, false, true, -0, Number.NaN, Infinity, -Infinity, 12n, Symbol("value")];
    const unexpected = () => { throw new Error("primitive prototype conversion was invoked"); };
    let actual: string[];
    try {
      vi.spyOn(Number.prototype, "toString").mockImplementation(unexpected);
      vi.spyOn(BigInt.prototype, "toString").mockImplementation(unexpected);
      vi.spyOn(Symbol.prototype, "toString").mockImplementation(unexpected);
      actual = values.map(formatCaughtPermissionFailure);
    } finally {
      vi.restoreAllMocks();
    }
    expect(actual).toEqual(["null", "undefined", "false", "true", "0", "NaN", "Infinity", "-Infinity", "12", "Symbol(value)"]);
  });

  it.each([
    { error: new Error("ordinary failure"), display: "Error: ordinary failure" },
    { error: new SyntaxError("invalid descriptor"), display: "SyntaxError: invalid descriptor" },
  ])("retains ordinary $display diagnostics", async ({ error, display }) => {
    const result = await inspectWindowsAcl("C:\\fixture", {
      env: ENV,
      exec: async () => { throw error; },
    });

    expect(result.error).toBe(display);
    expect(result.errorCause).toBe(error);
    expect(result.errorDetail).toBeUndefined();
  });

  it("escapes and bounds ordinary error display text", async () => {
    const error = new Error(`denied\n\u001b[31m${"x".repeat(500)}`);
    const result = await inspectWindowsAcl("C:\\fixture", {
      env: ENV,
      exec: async () => { throw error; },
    });

    expect(result.error).toHaveLength(400);
    expect(result.error).toMatch(/^Error: denied\\u000a\\u001b\[31m/u);
    expect(result.error).toMatch(/…$/u);
    expect(result.error).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it.each([
    { stderr: "access denied\n", expected: "access denied\\u000a" },
    { stderr: Buffer.from("buffer denied\n"), expected: "buffer denied\\u000a" },
  ])("retains raw command diagnostics for $expected", async ({ stderr, expected }) => {
    const error = Object.assign(new Error("command failed"), {
      code: 5,
      signal: null,
      killed: false,
      stderr,
      stdout: "PRIVATE_STDOUT",
    });
    const result = await inspectWindowsAcl("C:\\fixture", {
      env: ENV,
      exec: async () => { throw error; },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Error: command failed",
      errorDetail: {
        command: expect.stringContaining("powershell.exe"),
        durationMs: expect.any(Number),
        timedOut: false,
        exitCode: 5,
        signal: null,
        stderr: expected,
      },
    });
    expect(JSON.stringify(result.errorDetail)).not.toContain("PRIVATE_STDOUT");
    expect(result.errorCause).toBe(error);
  });

  it("retains wrapped timeout diagnostics without using instanceof", async () => {
    const cause = Object.assign(new Error("timed out"), {
      code: null,
      killed: true,
      signal: "SIGKILL",
      stderr: "deadline\n",
    });
    let wrapped: PermissionCommandError | undefined;
    const result = await inspectWindowsAcl("C:\\fixture", {
      env: ENV,
      exec: async (command) => {
        wrapped = new PermissionCommandError(command, 30_125, cause);
        throw wrapped;
      },
    });

    expect(result.errorCause).toBe(wrapped);
    expect(result).toMatchObject({
      error: "PermissionCommandError: Windows permission inspection timed out after 30000ms",
      errorDetail: {
        command: expect.stringContaining("powershell.exe"),
        durationMs: 30_125,
        timedOut: true,
        exitCode: null,
        signal: "SIGKILL",
        stderr: "deadline\\u000a",
      },
    });
  });

  it("extracts independent data metadata without invoking accessors", async () => {
    const counter = trapCounter();
    const error = Object.create(null);
    Object.defineProperties(error, {
      message: { get: counter.trap },
      code: { get: counter.trap },
      killed: { get: counter.trap },
      signal: { value: "SIGTERM" },
      stderr: { value: "partial diagnostics\n" },
      stdout: { get: counter.trap },
    });

    const result = await inspectWindowsAcl("C:\\fixture", {
      env: ENV,
      exec: async () => { throw error; },
    });

    expect(counter.count()).toBe(0);
    expect(result.error).toBe("Unknown object failure");
    expect(result.errorDetail).toMatchObject({
      timedOut: false,
      exitCode: null,
      signal: "SIGTERM",
      stderr: "partial diagnostics\\u000a",
    });
    expect(result.errorCause).toBe(error);
  });

  it("omits structured fields hidden behind accessors", async () => {
    const counter = trapCounter();
    const wrapped = new PermissionCommandError("powershell.exe", 4, new Error("failure"));
    for (const field of ["command", "durationMs", "timedOut", "exitCode", "signal", "stderr"]) {
      Object.defineProperty(wrapped, field, { configurable: true, get: counter.trap });
    }

    const result = await inspectWindowsAcl("C:\\fixture", {
      env: ENV,
      exec: async () => { throw wrapped; },
    });

    expect(counter.count()).toBe(0);
    expect(result.error).toBe(
      "PermissionCommandError: Windows permission command powershell.exe failed (exit code null, signal none)",
    );
    expect(result.errorDetail).toBeUndefined();
    expect(result.errorCause).toBe(wrapped);
  });

  itPosix("fails a simulated secure read before content access and closes its descriptor", async () => {
    configureFsSafeNative({ mode: "off" });
    const root = await tempRoot("fs-safe-owner-secure-read-");
    const target = path.join(root, "secret.json");
    const secret = "PRIVATE_FILE_CONTENT";
    await fs.writeFile(target, secret, { mode: 0o600 });
    const traps = trapCounter();
    const cause = new Proxy(new Error("hidden"), {
      get: traps.trap,
      getOwnPropertyDescriptor: traps.trap,
      getPrototypeOf: traps.trap,
      has: traps.trap,
      ownKeys: traps.trap,
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
    expect(traps.count()).toBe(0);
  });
});
