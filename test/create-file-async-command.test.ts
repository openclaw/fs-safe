import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsAsync, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFileHandle } from "../src/create.js";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import * as command from "../src/windows-security-command.js";
import { useTempDirs } from "./helpers/vitest.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(), spawnSync: vi.fn(),
}));

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeFallbackWarningsForTest();
  __resetNativeLoaderForTest();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function identity(stat: fs.BigIntStats): string {
  return `${stat.dev.toString(16).padStart(16, "0")}:${stat.ino.toString(16).padStart(32, "0")}`;
}

// Real filesystem identities exercise async ownership and publication here.
// The real Windows bridge tests separately prove creation-time ACL behavior.
function useAsyncWindowsCommands(mode: "off" | "auto" = "off") {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  configureFsSafeNative({ mode });
  __setNativeLoaderForTest(() => ({ closeOwnedFd: fs.closeSync }) as NativeBinding);
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  const synchronousCommand = () => { throw new Error("async creation invoked a synchronous security command"); };
  vi.mocked(spawnSync).mockImplementation(synchronousCommand);
  const syncCommands = [
    vi.spyOn(command, "createPrivateWindowsDirectoryCommandSync").mockImplementation(synchronousCommand),
    vi.spyOn(command, "inspectWindowsDirectoryCommandSync").mockImplementation(synchronousCommand),
    vi.spyOn(command, "protectPrivateWindowsFileCommandSync").mockImplementation(synchronousCommand),
    vi.spyOn(command, "verifyPrivateWindowsFileCommandSync").mockImplementation(synchronousCommand),
  ];
  const observed = (pathname: string) => identity(fs.lstatSync(pathname, { bigint: true }));
  const parentMatches = (pathname: string, expected: string | undefined) => {
    if (observed(path.dirname(pathname)) !== expected) throw new FsSafeError("path-mismatch", "parent changed");
  };
  const inspect = vi.spyOn(command, "inspectWindowsDirectoryCommand").mockImplementation(async pathname => ({ identity: observed(pathname) }));
  const create = vi.spyOn(command, "createPrivateWindowsDirectoryCommand").mockImplementation(async (pathname, parent) => {
    parentMatches(pathname, parent);
    await fsAsync.mkdir(pathname, { mode: 0o700 });
    return { identity: observed(pathname) };
  });
  const verifyIdentity = (fd: number, pathname: string, parent: string, links: number) => {
    parentMatches(pathname, parent);
    const held = fs.fstatSync(fd, { bigint: true });
    if (!held.isFile() || held.nlink !== BigInt(links) || identity(held) !== observed(pathname)) {
      throw new FsSafeError("path-mismatch", "file changed");
    }
    return identity(held);
  };
  const protect = vi.spyOn(command, "protectPrivateWindowsFileCommand").mockImplementation(async (fd, pathname, parent) => ({
    identity: verifyIdentity(fd, pathname, parent, 1),
  }));
  const verify = vi.spyOn(command, "verifyPrivateWindowsFileCommand").mockImplementation(async (fd, pathname, expected, parent, links = 1) => {
    if (verifyIdentity(fd, pathname, parent, links) !== expected) throw new FsSafeError("path-mismatch", "file changed");
  });
  const opened: { pathname: string; handle: FileHandle }[] = [];
  const open = fsAsync.open.bind(fsAsync);
  vi.spyOn(fsAsync, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    opened.push({ pathname: String(args[0]), handle });
    return handle;
  });
  return { inspect, create, protect, verify, opened, syncCommands };
}

type Outcome = { handle: FileHandle } | { error: unknown };
function outcome(operation: Promise<FileHandle>): Promise<Outcome> {
  return operation.then(handle => ({ handle }), error => ({ error }));
}

async function reachCommand<T>(entered: Promise<T>, completed: Promise<Outcome>): Promise<T> {
  return await Promise.race([entered, completed.then(result => {
    if ("error" in result) throw result.error;
    throw new Error("creation returned before the deferred security command");
  })]);
}

async function unsettledCommandFailure(): Promise<unknown> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false), unref: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const caught = command.inspectWindowsDescriptorCommand(73).catch(error => error);
    child.stderr.emit("error", new Error("command output failed before process exit"));
    await vi.advanceTimersByTimeAsync(1_000);
    const failure: unknown = await caught;
    expect(command.hasUnsettledWindowsSecurityCommand(failure)).toBe(true);
    expect(failure).toMatchObject({ processExitConfirmed: false });
    return failure;
  } finally { vi.useRealTimers(); }
}

it.each((["off", "auto"] as const).flatMap(mode =>
  (["protect", "verify"] as const).map(phase => ({ mode, phase }))))(
  "keeps the original fd and event loop live while async $phase waits (native $mode)", async ({ mode, phase }) => {
  const base = await tempRoot("fs-safe-async-command-");
  const target = path.join(base, "created");
  const fixture = useAsyncWindowsCommands(mode);
  const entered = deferred<{ fd: number; pathname: string }>();
  const release = deferred<void>();
  if (phase === "protect") {
    const protect = fixture.protect.getMockImplementation()!;
    fixture.protect.mockImplementationOnce(async (...args) => {
      const result = await protect(...args);
      entered.resolve({ fd: args[0], pathname: args[1] });
      await release.promise;
      return result;
    });
  } else {
    const verify = fixture.verify.getMockImplementation()!;
    fixture.verify.mockImplementationOnce(async (...args) => {
      await verify(...args);
      entered.resolve({ fd: args[0], pathname: args[1] });
      await release.promise;
    });
  }
  let settled = false;
  const completed = outcome(createFileHandle(target, { private: true })).finally(() => { settled = true; });
  try {
    const pending = await reachCommand(entered.promise, completed);
    const original = fixture.opened[0]!;
    expect(pending).toEqual({ fd: original.handle.fd, pathname: original.pathname });
    const pinned = fs.fstatSync(pending.fd, { bigint: true });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(fs.fstatSync(pending.fd, { bigint: true })).toMatchObject({ dev: pinned.dev, ino: pinned.ino });
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(pending.pathname)).toBe(true);
    release.resolve();
    const result = await completed;
    if ("error" in result) throw result.error;
    expect(await result.handle.stat({ bigint: true })).toMatchObject({ dev: pinned.dev, ino: pinned.ino, nlink: 1n });
    await result.handle.writeFile("async descriptor remains usable");
    expect(await fsAsync.readFile(target, "utf8")).toBe("async descriptor remains usable");
    expect(await fsAsync.readdir(base)).toEqual(["created"]);
    expect(spawnSync).not.toHaveBeenCalled();
    for (const sync of fixture.syncCommands) expect(sync).not.toHaveBeenCalled();
    expect(fixture.inspect).toHaveBeenCalled();
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.protect).toHaveBeenCalledOnce();
    expect(fixture.verify).toHaveBeenCalled();
  } finally {
    release.resolve();
    const result = await completed;
    if ("handle" in result) await result.handle.close();
  }
});

it("preserves the published file when a later async verification fails", async () => {
  const base = await tempRoot("fs-safe-async-published-failure-");
  const target = path.join(base, "created");
  const fixture = useAsyncWindowsCommands();
  const verify = fixture.verify.getMockImplementation()!;
  const failure = new Error("verification failed after publication");
  let published: fs.BigIntStats | undefined;
  fixture.verify.mockImplementation(async (...args) => {
    await verify(...args);
    if (args[1] === target && (args[4] ?? 1) === 1) {
      published = fs.fstatSync(args[0], { bigint: true });
      fs.writeSync(args[0], "published bytes", 0, "utf8");
      throw failure;
    }
  });
  const result = await outcome(createFileHandle(target, { private: true }));
  if ("handle" in result) {
    await result.handle.close();
    throw new Error("creation ignored the failed verification");
  }
  expect(result.error).toMatchObject({ code: "helper-failed", details: { publication: { status: "published" }, path: target } });
  expect(published).toBeDefined();
  expect(fs.statSync(target, { bigint: true })).toMatchObject({ dev: published!.dev, ino: published!.ino, nlink: 1n });
  expect(await fsAsync.readFile(target, "utf8")).toBe("published bytes");
  expect(await fsAsync.readdir(base)).toEqual(["created"]);
  expect(fixture.opened.every(({ handle }) => handle.fd === -1)).toBe(true);
  expect(spawnSync).not.toHaveBeenCalled();
});

it("preserves the unpublished stage when the async command's process exit is unconfirmed", async () => {
  const failure = await unsettledCommandFailure();
  const base = await tempRoot("fs-safe-async-unsettled-command-");
  const target = path.join(base, "created");
  const fixture = useAsyncWindowsCommands();
  const entered = deferred<{ fd: number; pathname: string }>();
  const release = deferred<void>();
  fixture.protect.mockImplementationOnce(async (fd, pathname) => {
    entered.resolve({ fd, pathname });
    await release.promise;
    throw failure;
  });
  const completed = outcome(createFileHandle(target, { private: true }));
  try {
    const pending = await reachCommand(entered.promise, completed);
    const staged = fs.fstatSync(pending.fd, { bigint: true });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(fs.statSync(pending.pathname, { bigint: true })).toMatchObject({ dev: staged.dev, ino: staged.ino });
    expect(fixture.opened[0]!.handle.fd).toBe(pending.fd);
    release.resolve();
    const result = await completed;
    if ("handle" in result) throw new Error("creation ignored the unsettled command");
    expect(result.error).toMatchObject({
      code: "helper-failed", cause: failure,
      details: { publication: { status: "not-published" }, cleanup: "preserved", path: target, stageDirectory: path.dirname(pending.pathname) },
    });
    expect(command.hasUnsettledWindowsSecurityCommand(result.error)).toBe(true);
    expect(fs.statSync(pending.pathname, { bigint: true })).toMatchObject({ dev: staged.dev, ino: staged.ino });
    expect(await fsAsync.readdir(base)).toEqual([path.basename(path.dirname(pending.pathname))]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fixture.opened.every(({ handle }) => handle.fd === -1)).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    const result = await completed;
    if ("handle" in result) await result.handle.close();
  }
});
