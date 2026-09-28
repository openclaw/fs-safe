import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { runPinnedWriteNative } from "../src/native-pinned-write.js";
import type { PinnedMutationParentRequest, PinnedWriteParams } from "../src/pinned-write-types.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { windowsPolicyBinding } from "./helpers/windows-policy-binding.js";

const { tempRoot } = useRealTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
});

async function fixture(platform: "win32" | "linux", reportCloseErrors = false) {
  const rootPath = await tempRoot("fs-safe-policy-parent-owner-");
  const rootIdentity = await fs.lstat(rootPath, { bigint: true });
  await fs.mkdir(path.join(rootPath, "one"));
  const native = windowsPolicyBinding(rootPath);
  const staging = vi.fn((): never => { throw new Error("unexpected file staging"); });
  Object.assign(native.binding, {
    createStagedFile: staging, stagedFileMatches: staging, removeStagedFile: staging,
  });
  const rootOpened: number[] = [];
  const rootClosed: number[] = [];
  const actualOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    const fd = handle.fd;
    rootOpened.push(fd);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      rootClosed.push(fd);
      await close();
    });
    return handle;
  });
  Object.defineProperty(process, "platform", { value: platform });
  const authorize = vi.fn(async (_request: Readonly<PinnedMutationParentRequest>) => undefined);
  const params: PinnedWriteParams = {
    rootPath, rootIdentity, relativeParentPath: "one/two/three", basename: "value",
    mkdir: true, mode: 0o600, sync: false, overwrite: false,
    input: { kind: "buffer", data: "payload", stageBeforePublish: reportCloseErrors },
    mutationAdmission: { rejectParentSymlinks: true, authorize },
  };
  return { ...native, rootPath, params, authorize, staging, rootOpened, rootClosed };
}

function suppressedBy(failure: unknown, closeFailure: Error): unknown {
  expect(failure).toMatchObject({ name: "SuppressedError" });
  const combined = failure as { error: unknown; suppressed: unknown };
  expect(combined.error).toBe(closeFailure);
  return combined.suppressed;
}

function expectClosed(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.opened).toHaveLength(2);
  expect(f.paths.size).toBe(0);
  expect(f.close).toHaveBeenCalledTimes(2);
  for (const fd of f.opened) expect(f.close.mock.calls.filter(([closed]) => closed === fd)).toHaveLength(1);
  expect(f.rootOpened).toHaveLength(1);
  expect(f.rootClosed).toEqual(f.rootOpened);
  for (const fd of [...f.opened, ...f.rootOpened]) {
    expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  }
  expect(f.staging).not.toHaveBeenCalled();
}

const failures = (["win32", "linux"] as const).flatMap(platform =>
  [false, true].flatMap(reportCloseErrors =>
    (["admission", "advance"] as const).map(failureAt => ({ platform, reportCloseErrors, failureAt })),
  ),
);

it.each(failures)(
  "$platform closes both owned children after $failureAt fails (reportCloseErrors=$reportCloseErrors)",
  async ({ platform, reportCloseErrors, failureAt }) => {
    const f = await fixture(platform, reportCloseErrors);
    const parentPath = path.join(f.rootPath, "one");
    const childPath = path.join(parentPath, "two");
    const operationFailure = new FsSafeError("denied-path", "opened child admission refused");
    const parentCloseFailure = new Error("previous parent closed before reporting failure");
    const childCloseFailure = new Error("new child closed before reporting failure");
    if (failureAt === "admission") {
      f.authorize.mockImplementation(async request => {
        if (request.phase === "parent" && [...f.paths.values()].includes(childPath)) throw operationFailure;
        return undefined;
      });
    }
    const close = f.close.getMockImplementation()!;
    const closeOrder: string[] = [];
    f.close.mockImplementation(fd => {
      const pathname = f.paths.get(fd);
      close(fd);
      if (pathname === parentPath || pathname === childPath) {
        closeOrder.push(pathname);
        throw pathname === parentPath ? parentCloseFailure : childCloseFailure;
      }
    });

    const failure = await runPinnedWriteNative(f.binding, f.params).catch(error => error);
    if (platform === "linux") {
      // POSIX parent walking preserves its existing final-close precedence.
      expect(failure).toBe(failureAt === "admission" ? parentCloseFailure : childCloseFailure);
    } else if (!reportCloseErrors) {
      expect(failure).toBe(failureAt === "admission" ? operationFailure : parentCloseFailure);
    } else if (failureAt === "admission") {
      expect(suppressedBy(suppressedBy(failure, parentCloseFailure), childCloseFailure)).toBe(operationFailure);
    } else {
      expect(suppressedBy(failure, childCloseFailure)).toBe(parentCloseFailure);
    }
    expect(closeOrder).toEqual(failureAt === "admission"
      ? [childPath, parentPath] : [parentPath, childPath]);
    expectClosed(f);
    expect(f.calls.mkdirChildBeneath).toHaveBeenCalledExactlyOnceWith(expect.any(Number), "two", 0o777);
    expect(await fs.readdir(childPath)).toEqual([]);
  },
);

it.each(["win32", "linux"] as const)(
  "%s dispatches parent mkdir before queued authority revocation and checks again for the next child",
  async platform => {
    const f = await fixture(platform);
    const refusal = new Error("authority revoked in a microtask");
    const events: string[] = [];
    let revoked = false;
    f.params.assertBeforeMutation = () => {
      events.push("authority");
      if (revoked) throw refusal;
      queueMicrotask(() => {
        events.push("revoked");
        revoked = true;
      });
    };
    const mkdir = f.calls.mkdirChildBeneath.getMockImplementation()!;
    f.calls.mkdirChildBeneath.mockImplementation(function (...args) {
      events.push(`mkdir:${args[1]}`);
      expect(revoked).toBe(false);
      return mkdir.apply(this, args);
    });

    await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toBe(refusal);
    expect(events).toEqual(["authority", "mkdir:two", "revoked", "authority"]);
    expectClosed(f);
    expect(await fs.readdir(path.join(f.rootPath, "one/two"))).toEqual([]);
  },
);
