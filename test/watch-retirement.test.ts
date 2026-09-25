import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchSubscription } from "../src/watch.js";
import { nativeWatchSupported, NodeWatchBackend } from "../src/watch-node.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

let dir: string;
let owners: WatchSubscription[];
const scopes = [{ path: "", kind: "tree" as const }];
beforeEach(async () => {
  dir = (await root(await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-watch-retire-")))).rootReal;
  owners = [];
});
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  await Promise.allSettled(owners.map(owner => owner.close()));
  await fs.rm(dir, { recursive: true, force: true });
});
function own(owner: WatchSubscription) { owners.push(owner); return owner; }
function failNativeRegistration() {
  const send = Worker.prototype.postMessage;
  let injected = false;
  // Fault the actual native add command; a retained pin now prevents the old
  // pathname-removal fixture from making fs.watch itself see ENOENT.
  return vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message, transfer) {
    if (!injected && message?.type === "add") {
      injected = true;
      message = { ...message, path: path.join(dir, "missing-native-target") };
    }
    return send.call(this, message, transfer);
  });
}

it.skipIf(!nativeWatchSupported)("joins failed real registration, then permits a new owner to observe a later edit", async () => {
  const authority = path.join(dir, "authority");
  await fs.mkdir(authority);
  const admitted = await root(authority);
  const fault = failNativeRegistration();
  const failed = own(watch(admitted, { scopes, onDirty() {} }));
  const observationError = await failed.ready.catch(error => error);
  expect(observationError).toMatchObject({ details: { operation: "watch", code: "ENOENT" } });
  await expect(failed.reconcile()).rejects.toBe(observationError);
  const closing = failed.close();
  expect(failed.close()).toBe(closing);
  await expect(closing).resolves.toBeUndefined();
  expect(failed.health()).toMatchObject({ state: "closed", workers: 0, directories: 0, error: observationError, failure: { operation: "watch", code: "ENOENT" } });
  await expect(failed.update(scopes)).rejects.toMatchObject({ name: "AbortError" });
  fault.mockRestore();
  let hints = 0;
  const recovered = own(watch(admitted, { scopes, onDirty() { hints++; } }));
  await recovered.ready;
  hints = 0;
  await fs.writeFile(path.join(authority, "later"), "observed");
  await expect.poll(() => hints).toBeGreaterThan(0);
  await expect(admitted.readText("later")).resolves.toBe("observed");
  await recovered.close();
});

it.skipIf(!nativeWatchSupported)("rejects a real-worker termination request failure, joins exit and never rearms", async () => {
  const owner = own(watch(await root(dir), { scopes, onDirty() {} }));
  await owner.ready;
  const terminationError = new Error("termination request failed");
  // Registrations and port are actually detached by the worker. Reject the
  // termination request, not the owner's close method; exit must still be joined.
  const terminate = vi.spyOn(Worker.prototype, "terminate").mockRejectedValueOnce(terminationError);
  const closing = owner.close();
  expect(owner.close()).toBe(closing);
  await expect(closing).rejects.toBe(terminationError);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(owner.health()).toMatchObject({ state: "closed", workers: 0, directories: 0, error: terminationError, failure: { operation: "close" } });
  await expect(owner.update(scopes)).rejects.toMatchObject({ name: "AbortError" });
  await expect(owner.reconcile()).rejects.toMatchObject({ name: "AbortError" });
  await expect(owner.close()).rejects.toBe(terminationError);
  expect(terminate).toHaveBeenCalledTimes(1);
});


it.skipIf(!nativeWatchSupported)("keeps an automatic retirement failure after the failed backend has been removed", async () => {
  const authority = path.join(dir, "authority");
  await fs.mkdir(authority);
  const admitted = await root(authority);
  const terminationError = new Error("failed-observer termination request");
  vi.spyOn(Worker.prototype, "terminate").mockRejectedValueOnce(terminationError);
  failNativeRegistration();
  const owner = own(watch(admitted, { scopes, onDirty() {} }));
  const observationError = await owner.ready.catch(error => error);
  expect(observationError).toMatchObject({ details: { operation: "watch", code: "ENOENT" } });
  await expect.poll(() => owner.health().workers).toBe(0);
  await expect(owner.reconcile()).rejects.toBe(observationError);
  const closing = owner.close();
  await expect(closing).rejects.toMatchObject({ name: "SuppressedError", error: terminationError, suppressed: observationError });
  expect(owner.close()).toBe(closing);
  expect(owner.health()).toMatchObject({ state: "closed", failure: { operation: "close" }, error: { error: terminationError, suppressed: observationError } });
});

it.skipIf(!nativeWatchSupported)("does not rearm an update after the first generation retirement fails", async () => {
  let created = 0;
  __setFsSafeTestHooksForTest({ afterWatchBackendCreated: () => { created++; } });
  const owner = own(watch(await root(dir), { scopes, onDirty() {} }));
  await owner.ready;
  const terminationError = new Error("generation retirement failed");
  vi.spyOn(Worker.prototype, "terminate").mockRejectedValueOnce(terminationError);
  await expect(owner.update([{ path: "later", kind: "entry" }])).rejects.toBe(terminationError);
  await expect(owner.reconcile()).rejects.toBe(terminationError);
  await expect(owner.update(scopes)).rejects.toBe(terminationError);
  await expect(owner.close()).rejects.toBe(terminationError);
  expect(created).toBe(1);
  expect(owner.health()).toMatchObject({ state: "closed", workers: 0 });
});

it.skipIf(!nativeWatchSupported)("retains worker errors occurring after detach acknowledgement during join", async () => {
  const backend = new NodeWatchBackend(() => {}, () => {}, true, 2);
  const terminate = Worker.prototype.terminate;
  const joinError = new Error("worker failed during join");
  vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
    this.emit("error", joinError);
    return terminate.call(this);
  });
  await backend.add(dir, "");
  await expect(backend.close()).rejects.toBe(joinError);
  await expect(backend.add(dir, "")).rejects.toMatchObject({ name: "AbortError" });
});

it.skipIf(!nativeWatchSupported)("owns failed close-command transport and still joins the worker", async () => {
  const backend = new NodeWatchBackend(() => {}, () => {}, true, 2);
  // No registration is admitted in this fault fixture, including on runtimes
  // whose shared driver needs an explicit detach message to release watches.
  const transportError = new Error("close transport failed");
  vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => { throw transportError; });
  const closing = backend.close();
  expect(backend.close()).toBe(closing);
  await expect(closing).rejects.toBe(transportError);
  expect(backend.directoryCount()).toBe(0);
});

it.each([false, true])("retains directory cleanup failure during scan (closing=%s)", async closingDuringScan => {
  const admitted = await root(dir);
  const cleanupError = new Error("directory cleanup failed");
  const opendir = fs.opendir;
  let owner!: WatchSubscription;
  let closing: Promise<void> | undefined;
  vi.spyOn(fs, "opendir").mockImplementationOnce(async (name, options) => {
    const handle = await opendir(name, options);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      throw cleanupError;
    });
    if (closingDuringScan) closing = owner.close();
    return handle;
  });
  owner = own(watch(admitted, { mode: "poll", scopes, onDirty() {} }));
  await expect(owner.ready).rejects.toBeDefined();
  closing ??= owner.close();
  await expect(closing).rejects.toBeDefined();
  expect(owner.health()).toMatchObject({ state: "closed", workers: 0, failure: { operation: "close" } });
  const error = await closing.catch(error => error);
  expect(error === cleanupError || error.error === cleanupError).toBe(true);
  expect(owner.close()).toBe(closing);
});
