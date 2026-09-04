import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSuiteFixture } from "./helpers/suite-fixture.js";

const hooks = vi.hoisted(() => ({
  setup: undefined as (() => Promise<unknown>) | undefined,
  cleanup: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("vitest", async (importOriginal) => ({
  ...await importOriginal<typeof import("vitest")>(),
  beforeAll: (callback: () => Promise<unknown>) => { hooks.setup = callback; },
  afterAll: (callback: () => Promise<void>) => { hooks.cleanup = callback; },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  hooks.setup = undefined;
  hooks.cleanup = undefined;
});

describe("suite fixture lifetime", () => {
  it("drains unfinished setup before removing a partially prepared fixture", async () => {
    const gate = deferred();
    const cleanup = vi.fn(async () => {});
    const failure = new Error("copy failed");
    useSuiteFixture(async () => { await gate.promise; }, cleanup);
    const setup = hooks.setup!();
    const rejected = expect(setup).rejects.toBe(failure);
    const teardown = hooks.cleanup!();
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    gate.reject(failure);
    await rejected;
    await teardown;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("serializes unfinished test work and drains it before teardown", async () => {
    const gate = deferred();
    const events: string[] = [];
    const run = useSuiteFixture(async () => "fixture", async () => { events.push("cleanup"); });
    await hooks.setup!();
    const first = run(async (fixture) => {
      expect(fixture).toBe("fixture");
      events.push("first");
      await gate.promise;
      events.push("settled");
    });
    const second = run(async () => { events.push("second"); });
    const teardown = hooks.cleanup!();
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    await expect(run(async () => {})).rejects.toThrow("suite fixture is closing");
    gate.resolve();
    await Promise.all([first, second, teardown]);
    expect(events).toEqual(["first", "settled", "second", "cleanup"]);
  });

  it("preserves a test failure while still waiting for its work before cleanup", async () => {
    const gate = deferred();
    const cleanup = vi.fn(async () => {});
    const failure = new Error("operation failed");
    const run = useSuiteFixture(async () => undefined, cleanup);
    await hooks.setup!();
    const operation = run(async () => { await gate.promise; });
    const rejected = expect(operation).rejects.toBe(failure);
    const teardown = hooks.cleanup!();
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    gate.reject(failure);
    await rejected;
    await teardown;
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
