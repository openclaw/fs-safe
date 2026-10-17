import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { encodeWatchError } from "../src/watch-io-error.js";

const { workers } = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    messages: any[] = [];
    referenced = true;
    terminated = false;
    postFailure?: Error;
    constructor() { super(); workers.push(this); }
    ref() { this.referenced = true; }
    unref() { this.referenced = false; }
    postMessage(message: unknown) {
      if (this.postFailure) throw this.postFailure;
      this.messages.push(structuredClone(message));
    }
    async terminate() { this.terminated = true; return 0; }
  } };
});
import { WatchEndpoint } from "../src/watch-io.js";

afterEach(() => { workers.length = 0; });

it("correlates concurrent replies and preserves cleanup error identity", async () => {
  const endpoint = new WatchEndpoint();
  const worker = workers.at(-1)!;
  expect(worker.referenced).toBe(false);
  const cleanup = vi.fn();
  const first = endpoint.call(undefined, cleanup, "first", 1).catch(error => error);
  const second = endpoint.call(undefined, undefined, "second", 2);
  expect(worker.messages.map((message: any) => [message.method, message.args])).toEqual([["first", [1]], ["second", [2]]]);
  expect(worker.referenced).toBe(true);
  worker.emit("message", { id: worker.messages[1].id, value: "second reply" });
  await expect(second).resolves.toBe("second reply");
  expect(worker.referenced).toBe(true);
  const cause = Object.assign(new Error("descriptor race"), { code: "EBADF", syscall: "realpath" });
  const wire = encodeWatchError(new FsSafeError("path-mismatch", "changed", { cause }));
  worker.emit("message", { id: worker.messages[0].id, failed: true, error: wire,
    cleanupErrors: [wire, encodeWatchError(new Error("separate cleanup"))] });
  const error = await first;
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "path-mismatch", cause: { code: "EBADF", syscall: "realpath" } });
  expect(cleanup.mock.calls[0][0]).toBe(error);
  expect(cleanup.mock.calls[1][0]).toMatchObject({ message: "separate cleanup" });
  expect(worker.referenced).toBe(false);
  await endpoint.close();
  expect(worker.terminated).toBe(true);
});

it.each(["error", "exit"])("rejects pending and future requests after worker %s", async event => {
  const endpoint = new WatchEndpoint();
  const worker = workers.at(-1)!;
  const first = endpoint.call(undefined, undefined, "first").catch(error => error);
  const second = endpoint.call(undefined, undefined, "second").catch(error => error);
  worker.emit(event, event === "error" ? new Error("worker failed") : 7);
  const failure = await first;
  expect(failure).toMatchObject({ code: "helper-failed", cause: { message: event === "error" ? "worker failed" : "watch observation worker exited (7)" } });
  expect(await second).toBe(failure);
  await expect(endpoint.call(undefined, undefined, "later")).rejects.toBe(failure);
  expect(worker.messages).toHaveLength(2);
  await endpoint.close();
  expect(worker.terminated).toBe(true);
});

it("keeps persistent owners referenced and recovers from a rejected message", async () => {
  const endpoint = new WatchEndpoint();
  const worker = workers.at(-1)!;
  endpoint.persistent++;
  endpoint.updateRef();
  expect(worker.referenced).toBe(true);
  worker.postFailure = new Error("cannot clone request");
  await expect(endpoint.call(undefined, undefined, "uncloneable")).rejects.toBe(worker.postFailure);
  worker.postFailure = undefined;
  const result = endpoint.call(undefined, undefined, "valid");
  worker.emit("message", { id: worker.messages[0].id, value: 42 });
  await expect(result).resolves.toBe(42);
  expect(worker.referenced).toBe(true);
  endpoint.persistent--;
  endpoint.updateRef();
  expect(worker.referenced).toBe(false);
  await endpoint.close();
  expect(worker.terminated).toBe(true);
});
