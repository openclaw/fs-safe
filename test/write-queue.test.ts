import { describe, expect, it } from "vitest";
import { serializePathWrite } from "../src/write-queue.js";

describe("path write queue", () => {
  it("keeps same-key FIFO through failures and thenables while other keys progress", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const key = "write-queue-contract-fifo";
    const failure = new Error("third failed synchronously");
    const first = serializePathWrite(key, function (this: unknown, ...args: unknown[]) {
      expect(this).toBeUndefined();
      expect(args).toEqual([]);
      events.push("first");
      started.resolve();
      return release.promise.then(() => { events.push("first settled"); throw undefined; });
    });
    const second = serializePathWrite(key, function (this: unknown, ...args: unknown[]) {
      expect(this).toBeUndefined();
      expect(args).toEqual([]);
      events.push("second");
      return {
        then(resolve: (value: string) => void) {
          events.push("thenable");
          resolve("second value");
        },
      } as unknown as Promise<string>;
    });
    const third = serializePathWrite(key, () => { events.push("third"); throw failure; });
    const fourth = serializePathWrite(key, async () => { events.push("fourth"); return 4; });
    const results = Promise.allSettled([first, second, third, fourth]);
    const independent = serializePathWrite(`${key}-other`, async () => {
      events.push("independent");
      return "other value";
    });
    try {
      await started.promise;
      await expect(independent).resolves.toBe("other value");
      expect(events).toEqual(["first", "independent"]);
    } finally {
      release.resolve();
    }
    expect(await results).toEqual([
      { status: "rejected", reason: undefined },
      { status: "fulfilled", value: "second value" },
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: 4 },
    ]);
    expect(events).toEqual(["first", "independent", "first settled", "second", "thenable", "third", "fourth"]);
  });

  it("retains a queued successor when its predecessor settles and another write arrives", async () => {
    const key = "write-queue-contract-settlement";
    const secondStarted = Promise.withResolvers<void>();
    const finishSecond = Promise.withResolvers<void>();
    const lateQueued = Promise.withResolvers<void>();
    const events: string[] = [];
    let secondFinished = false;
    const first = serializePathWrite(key, async () => { events.push("first"); return 1; });
    const second = serializePathWrite(key, () => {
      events.push("second");
      secondStarted.resolve();
      return finishSecond.promise.then(() => {
        secondFinished = true;
        events.push("second settled");
        return 2;
      });
    });
    const late = first.then(() => {
      const pending = serializePathWrite(key, async () => {
        expect(secondFinished).toBe(true);
        events.push("late");
        return 3;
      });
      lateQueued.resolve();
      return pending;
    });
    const results = Promise.all([first, second, late]);
    try {
      await Promise.all([secondStarted.promise, lateQueued.promise]);
      expect(secondFinished).toBe(false);
      expect(events).toEqual(["first", "second"]);
    } finally {
      finishSecond.resolve();
    }
    await expect(results).resolves.toEqual([1, 2, 3]);
    expect(events).toEqual(["first", "second", "second settled", "late"]);
    await expect(serializePathWrite(key, async () => 4)).resolves.toBe(4);
  });
});
