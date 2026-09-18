import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS } from "../src/permission-exec.js";
import { createPrivateWindowsDirectoryCommand, inspectWindowsDescriptorCommand } from "../src/windows-security-command.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => false), unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

function observe(result: Promise<unknown>) {
  const outcome: { resolved?: unknown; rejected?: unknown } = {};
  const done = result.then(value => { outcome.resolved = value; }, error => { outcome.rejected = error; });
  return { outcome, done };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("Windows security command bounded settlement", () => {
  it("rejects after timeout and grace even when kill is refused and close never arrives", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const { outcome, done } = observe(inspectWindowsDescriptorCommand(73));
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS + 999);
    expect(outcome).toEqual({});
    expect(child.stdout.destroyed).toBe(false);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    try {
      expect(outcome.rejected).toMatchObject({ timedOut: true, signal: null, cause: {
        processExitConfirmed: false, outputClosed: false, terminationSignalSent: false,
      } });
      expect((outcome.rejected as Error).message).toContain("process exit was not confirmed");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      child.emit("close", null, "SIGKILL");
      await done;
    }
  });

  it.each(["returns true", "throws", "emits error"])("bounds settlement when kill %s without confirming exit", async behavior => {
    vi.useFakeTimers();
    const child = childProcess();
    const killError = Object.assign(new Error("termination denied"), { code: "EPERM" });
    child.kill.mockImplementation(() => {
      if (behavior === "throws") throw killError;
      if (behavior === "emits error") child.emit("error", killError);
      return behavior === "returns true";
    });
    const { outcome, done } = observe(createPrivateWindowsDirectoryCommand("C:\\private"));
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS + 1_000);
    await done;
    expect(outcome.rejected).toMatchObject({ timedOut: true, exitCode: null, signal: null, cause: {
      processExitConfirmed: false, outputClosed: false, creationOutcome: "unconfirmed",
      ...(behavior === "returns true" ? { terminationSignalSent: true } : { terminationError: killError }),
    } });
    expect((outcome.rejected as Error).message).toContain("private-directory creation outcome is unconfirmed");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(() => { child.emit("error", killError); child.emit("error", killError); }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stdout", "stderr"] as const)("preserves the first %s failure without extending grace or becoming a timeout", async stream => {
    vi.useFakeTimers();
    const child = childProcess();
    const failure = new Error("first pipe failure");
    const { outcome, done } = observe(inspectWindowsDescriptorCommand(73));
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS - 200);
    child[stream].emit("error", failure);
    await vi.advanceTimersByTimeAsync(999);
    child.stdout.emit("error", new Error("late stdout error"));
    child.stderr.emit("error", new Error("late stderr error"));
    child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
    expect(outcome).toEqual({});
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(outcome.rejected).toMatchObject({ timedOut: false, signal: null, cause: { cause: failure } });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an output-budget failure without waiting for process or pipe completion", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const { outcome, done } = observe(inspectWindowsDescriptorCommand(73));
    child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(outcome.rejected).toMatchObject({ timedOut: false, cause: {
      cause: { message: "Windows security command exceeded its output budget" },
      processExitConfirmed: false, outputClosed: false,
    } });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("joins close during grace and retains the original failure", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const destroy = vi.spyOn(child.stdout, "destroy");
    const failure = new Error("pipe failure");
    const { outcome, done } = observe(inspectWindowsDescriptorCommand(73));
    child.stderr.emit("error", failure);
    await vi.advanceTimersByTimeAsync(500);
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await done;
    expect(outcome.rejected).toMatchObject({ timedOut: false, signal: "SIGKILL", cause: {
      cause: failure, processExitConfirmed: true, outputClosed: true,
    } });
    expect(destroy).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes observed exit from descendant-held pipes and ignores late success and errors", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const { outcome, done } = observe(createPrivateWindowsDirectoryCommand("C:\\private"));
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS + 1_000);
    await done;
    const failure = outcome.rejected;
    expect(failure).toMatchObject({ timedOut: true, exitCode: 0, signal: null, cause: {
      processExitConfirmed: true, outputClosed: false, creationOutcome: "unconfirmed",
    } });
    expect((failure as Error).message).toContain("command output did not close");
    expect(child.kill).not.toHaveBeenCalled();
    expect(() => {
      child.stdout.emit("data", Buffer.from('{"ok":true,"result":{"created":true}}'));
      child.emit("close", 0, null);
      for (const emitter of [child, child.stdout, child.stderr]) {
        emitter.emit("error", new Error("late error"));
        emitter.emit("error", new Error("another late error"));
      }
    }).not.toThrow();
    await Promise.resolve();
    expect(outcome).toEqual({ rejected: failure });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a failed spawn's OS error when its pipes and close event are absent", async () => {
    vi.useFakeTimers();
    const failure = Object.assign(new Error("spawn failed"), { code: "EMFILE" });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn(() => false), unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      process.nextTick(() => child.emit("error", failure));
      return child as unknown as ReturnType<typeof spawn>;
    });
    await Promise.resolve();
    const { outcome, done } = observe(inspectWindowsDescriptorCommand(73));
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(outcome.rejected).toMatchObject({ timedOut: false, cause: { cause: failure } });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects successful output after the deadline even before its timer callback runs", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const child = childProcess();
    const { outcome, done } = observe(createPrivateWindowsDirectoryCommand("C:\\private"));
    child.stdout.emit("data", Buffer.from('{"ok":true,"result":{"created":true}}'));
    now.mockReturnValue(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS + 1);
    child.emit("close", 0, null);
    await done;
    expect(outcome.rejected).toMatchObject({ timedOut: true, cause: { processExitConfirmed: true, outputClosed: true } });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
