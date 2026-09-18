import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertSyncDirectoryGuard, createSyncDirectoryGuard } from "../src/directory-guard.js";
import { FsSafeError } from "../src/errors.js";
import { handoffCreatedFile } from "../src/private-producer-handoff.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const handles = new Set<FileHandle>();
const operations = new Set<Promise<void>>();
const releases = new Set<() => void>();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(async () => {
  for (const release of releases) release();
  await Promise.all(operations);
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  for (const handle of handles) await handle.close().catch(() => undefined);
  handles.clear();
  operations.clear();
  releases.clear();
  __cleanupRegisteredTempPathsForTest();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.add(release);
  return { promise, release };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type HandoffOptions = Parameters<typeof handoffCreatedFile>[0];

async function fixture() {
  const directory = await tempRoot("fs-safe-created-async-");
  const stage = path.join(directory, "private");
  await fs.mkdir(stage);
  const sourcePath = path.join(stage, "source");
  const targetPath = path.join(directory, "target");
  const source = await fs.open(sourcePath, "wx+", 0o600);
  handles.add(source);
  await source.writeFile("producer");
  const identity = await source.stat({ bigint: true });
  const sourceParent = createSyncDirectoryGuard(stage);
  const targetParent = createSyncDirectoryGuard(directory);
  function run(options: Partial<HandoffOptions> = {}) {
    const pending = handoffCreatedFile({
      source, sourcePath, targetPath, identity,
      assertSourceParent: () => assertSyncDirectoryGuard(sourceParent),
      assertTargetParent: () => assertSyncDirectoryGuard(targetParent),
      ...options,
    }).then(handle => { handles.add(handle); return handle; });
    operations.add(pending.then(() => undefined, () => undefined));
    return pending;
  }
  return { directory, stage, sourcePath, targetPath, source, identity, run };
}

function observeOpens(observe: (file: string, flags: string | number, handle: FileHandle) => void) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    handles.add(handle);
    observe(String(args[0]), args[1], handle);
    return handle;
  });
}

it("publishes the supplied inode and returns a usable single-linked handle", async () => {
  const f = await fixture();
  const result = await f.run();
  expect(await result.stat({ bigint: true })).toMatchObject({
    dev: f.identity.dev, ino: f.identity.ino, nlink: 1n,
  });
  await fs.rmdir(f.stage);
  await result.write(Buffer.from("!"), 0, 1, 8);
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("producer!");
  __cleanupRegisteredTempPathsForTest();
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("producer!");
});

it.each(["parent", "identity", "descriptor"] as const)("consumes the supplied handle when initial %s admission fails", async fault => {
  const f = await fixture();
  const close = vi.spyOn(f.source, "close");
  const rejected = new FsSafeError("path-mismatch", "initial admission rejected");
  const options: Partial<HandoffOptions> = {};
  if (fault === "parent") options.assertSourceParent = () => { throw rejected; };
  else if (fault === "identity") options.identity = fsSync.lstatSync(f.stage, { bigint: true });
  else {
    const fstat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      if (args[0] === f.source.fd) throw rejected;
      return fstat(...args);
    });
  }
  await expect(f.run(options)).rejects.toMatchObject({
    code: fault === "identity" ? "not-file" : "path-mismatch",
    details: { publication: { status: "not-published" }, cleanup: "preserved", resources: "closed" },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(f.source.fd).toBe(-1);
  expect(fsSync.existsSync(f.targetPath)).toBe(false);
});

it.each(["replacement", "authority"] as const)("rechecks %s after deferred initial verification", async change => {
  const f = await fixture();
  const entered = gate();
  const proceed = gate();
  const denied = new FsSafeError("denied-path", "authority expired during verification");
  const close = vi.spyOn(f.source, "close");
  let authorized = true;
  const pending = f.run({
    verifyDescriptor: async () => { entered.release(); await proceed.promise; },
    assertBeforeMutation: () => { if (!authorized) throw denied; },
  });
  await entered.promise;
  await tick();
  expect(f.source.fd).toBeGreaterThanOrEqual(0);
  expect(fsSync.existsSync(f.targetPath)).toBe(false);
  if (change === "replacement") {
    await fs.rename(f.sourcePath, path.join(f.directory, "saved"));
    await fs.writeFile(f.sourcePath, "competitor");
  } else authorized = false;
  proceed.release();
  await expect(pending).rejects.toMatchObject({
    code: change === "replacement" ? "path-mismatch" : "denied-path",
    details: { publication: { status: "not-published" }, cleanup: "preserved", resources: "closed" },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(f.source.fd).toBe(-1);
  expect(fsSync.existsSync(f.targetPath)).toBe(false);
  expect(await fs.readFile(f.sourcePath, "utf8")).toBe(change === "replacement" ? "competitor" : "producer");
});

it.each([2, 1])("preserves publication when deferred verification rejects with %s links", async links => {
  const f = await fixture();
  observeOpens(() => undefined);
  const entered = gate();
  const proceed = gate();
  const rejected = new FsSafeError("insecure-permissions", "descriptor verification rejected");
  const close = vi.spyOn(f.source, "close");
  const onPublished = vi.fn();
  let pinned = f.source;
  let settled = false;
  const pending = f.run({
    onPublished,
    verifyDescriptor: async (fd, file, currentLinks) => {
      if (currentLinks === links && (links === 2 || file === f.targetPath)) {
        pinned = [...handles].find(handle => handle.fd === fd)!;
        entered.release();
        await proceed.promise;
        throw rejected;
      }
    },
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise;
  await tick();
  expect(settled).toBe(false);
  expect(pinned.fd).toBeGreaterThanOrEqual(0);
  expect(fsSync.fstatSync(pinned.fd, { bigint: true }).nlink).toBe(BigInt(links));
  expect(fsSync.existsSync(f.sourcePath)).toBe(links === 2);
  expect(onPublished).toHaveBeenCalledOnce();
  __cleanupRegisteredTempPathsForTest();
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("producer");
  proceed.release();
  await expect(pending).rejects.toMatchObject({
    code: "insecure-permissions", cause: rejected,
    details: { publication: { status: "published" }, cleanup: links === 2 ? "preserved" : "removed", resources: "closed" },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(f.source.fd).toBe(-1);
  expect(pinned.fd).toBe(-1);
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("producer");
});

it("joins Windows close failures without retrying a consumed source handle", async () => {
  const f = await fixture();
  Object.defineProperty(process, "platform", { value: "win32" });
  const sourceClosing = gate();
  const sourceFinish = gate();
  const siblingClosing = gate();
  const siblingFinish = gate();
  const sourceFailure = new Error("source close failed after release");
  const siblingFailure = new Error("sibling close failed after release");
  const sourceClose = f.source.close.bind(f.source);
  const closeSource = vi.spyOn(f.source, "close").mockImplementation(async () => {
    await sourceClose();
    sourceClosing.release();
    await sourceFinish.promise;
    throw sourceFailure;
  });
  let sibling: FileHandle | undefined;
  let siblingCloses = 0;
  observeOpens((file, flags, handle) => {
    expect(file).toBe(f.targetPath);
    expect(flags).toBe(fsSync.constants.O_RDWR);
    expect(f.source.fd).toBeGreaterThanOrEqual(0);
    sibling = handle;
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      siblingCloses++;
      await close();
      siblingClosing.release();
      await siblingFinish.promise;
      throw siblingFailure;
    });
  });
  let settled = false;
  const pending = f.run({
    verifyDescriptor: async (fd, file) => {
      if (file === f.targetPath) {
        expect(fd).toBe(sibling!.fd);
        expect(f.source.fd).toBeGreaterThanOrEqual(0);
      }
    },
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await sourceClosing.promise;
  await tick();
  expect(settled).toBe(false);
  expect(f.source.fd).toBe(-1);
  expect(sibling!.fd).toBeGreaterThanOrEqual(0);
  expect(fsSync.existsSync(f.sourcePath)).toBe(true);
  sourceFinish.release();
  await siblingClosing.promise;
  await tick();
  expect(settled).toBe(false);
  expect(sibling!.fd).toBe(-1);
  expect(fsSync.existsSync(f.sourcePath)).toBe(true);
  siblingFinish.release();
  const error = await pending.catch(error => error);
  expect(error).toMatchObject({
    code: "helper-failed",
    details: { publication: { status: "published" }, cleanup: "preserved", resources: "close-failed" },
  });
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect(error.cause.errors).toEqual([sourceFailure, siblingFailure]);
  expect(closeSource).toHaveBeenCalledOnce();
  expect(siblingCloses).toBe(1);
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("producer");
});

it("preserves ambiguous publication and waits for source close before rejecting", async () => {
  const f = await fixture();
  const closing = gate();
  const finish = gate();
  const sourceClose = f.source.close.bind(f.source);
  const close = vi.spyOn(f.source, "close").mockImplementation(async () => {
    await sourceClose();
    closing.release();
    await finish.promise;
  });
  const dispatched = Object.assign(new Error("link response lost"), { code: "EIO" });
  const link = fsSync.linkSync.bind(fsSync);
  vi.spyOn(fsSync, "linkSync").mockImplementation((...args) => { link(...args); throw dispatched; });
  const onPublished = vi.fn();
  let settled = false;
  const pending = f.run({ onPublished });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await closing.promise;
  await tick();
  expect(settled).toBe(false);
  expect(onPublished).not.toHaveBeenCalled();
  expect(await fs.readFile(f.sourcePath, "utf8")).toBe("producer");
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("producer");
  finish.release();
  await expect(pending).rejects.toMatchObject({
    cause: dispatched,
    details: { publication: { status: "indeterminate" }, cleanup: "preserved", resources: "closed" },
  });
  expect(close).toHaveBeenCalledOnce();
  __cleanupRegisteredTempPathsForTest();
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("producer");
});

it.each([false, true])("preserves a collision with close failure %s", async closeFails => {
  const f = await fixture();
  const closeFailure = new Error("collision close failed after release");
  const sourceClose = f.source.close.bind(f.source);
  const close = vi.spyOn(f.source, "close").mockImplementation(async () => {
    await sourceClose();
    if (closeFails) throw closeFailure;
  });
  const error = await f.run({
    assertBeforeMutation: () => fsSync.writeFileSync(f.targetPath, "winner", { flag: "wx" }),
  }).catch(error => error);
  expect(error).toMatchObject({
    code: closeFails ? "helper-failed" : "already-exists",
    details: { publication: { status: "not-published" }, resources: closeFails ? "close-failed" : "closed" },
  });
  if (closeFails) {
    expect(error.cause.errors).toEqual([expect.objectContaining({ code: "already-exists" }), closeFailure]);
  }
  expect(close).toHaveBeenCalledOnce();
  expect(f.source.fd).toBe(-1);
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("winner");
});

it.each([1, 2])("refuses a thenable authority check before mutation %s", async rejectedMutation => {
  const f = await fixture();
  let mutations = 0;
  await expect(f.run({
    assertBeforeMutation: () => {
      if (++mutations === rejectedMutation) return Promise.reject(new Error("async authority"));
    },
  })).rejects.toMatchObject({
    code: "helper-failed", cause: new TypeError("assertBeforeMutation must be synchronous"),
    details: { publication: { status: rejectedMutation === 1 ? "not-published" : "published" }, cleanup: "preserved", resources: "closed" },
  });
  expect(f.source.fd).toBe(-1);
  expect(fsSync.existsSync(f.targetPath)).toBe(rejectedMutation === 2);
  expect(await fs.readFile(f.sourcePath, "utf8")).toBe("producer");
  await tick();
});
