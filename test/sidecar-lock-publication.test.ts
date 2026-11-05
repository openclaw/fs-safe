import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const kinds = ["raw-async", "raw-sync", "root-async", "root-sync"] as const;
type Kind = typeof kinds[number];
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest(undefined);
  __resetNativeLoaderForTest();
  configureFsSafeNative({ mode: "auto" });
});

async function acquire(target: string, kind: Kind, managerKey = target) {
  const options = {
    payload: () => ({ pid: process.pid, owner: "complete" }),
    timeoutMs: 0, retry: { retries: 0 }, staleMs: Infinity, managerKey,
    ...(kind.startsWith("root") ? { lockRoot: await root(path.dirname(target)) } : {}),
  };
  return kind.endsWith("async") ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
}

it.each(kinds)("%s never exposes the final sidecar while writing its owner record", async kind => {
  const target = path.join(await tempRoot("fs-safe-publish-"), "state");
  const lockPath = `${target}.lock`;
  const visibleDuringWrite: boolean[] = [];
  for (const method of ["writeFileSync", "writeSync", "writeFile", "write"] as const) {
    const original = fs[method];
    vi.spyOn(fs, method).mockImplementation((...args: unknown[]) => {
      visibleDuringWrite.push(fs.existsSync(lockPath));
      return Reflect.apply(original, fs, args);
    });
  }
  const originalOpen = promises.open;
  vi.spyOn(promises, "open").mockImplementation(async (...args) => {
    const handle = await Reflect.apply(originalOpen, promises, args);
    const write = handle.writeFile.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementation(async (...values) => {
      visibleDuringWrite.push(fs.existsSync(lockPath));
      return await write(...values);
    });
    const writeChunk = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementation((...values: unknown[]) => {
      visibleDuringWrite.push(fs.existsSync(lockPath));
      return Reflect.apply(writeChunk, handle, values);
    });
    return handle;
  });
  const lock = await acquire(target, kind);
  try {
    expect(visibleDuringWrite.length).toBeGreaterThan(0);
    expect(visibleDuringWrite).not.toContain(true);
    expect(JSON.parse(await promises.readFile(lockPath, "utf8"))).toEqual({ pid: process.pid, owner: "complete" });
    expect(fs.statSync(lockPath).nlink).toBe(1);
    expect(await promises.readdir(path.dirname(target))).toEqual(["state.lock"]);
  } finally { await lock.release(); }
});

it.each(kinds)("%s cleans an interrupted stage and preserves a concurrent winner", async kind => {
  const directory = await tempRoot("fs-safe-stage-rollback-");
  const target = path.join(directory, "state"), lockPath = `${target}.lock`;
  let staged = false;
  __setFsSafeTestHooksForTest({ beforeSidecarLockPublish(final, temporary) {
    expect(final).toBe(lockPath);
    expect(fs.existsSync(final)).toBe(false);
    expect(JSON.parse(fs.readFileSync(temporary, "utf8")).owner).toBe("complete");
    staged = true;
    fs.writeFileSync(final, '{"owner":"winner"}', { flag: "wx" });
  } });
  await expect(acquire(target, kind)).rejects.toMatchObject({ code: "file_lock_timeout" });
  expect(staged).toBe(true);
  expect(await promises.readFile(lockPath, "utf8")).toBe('{"owner":"winner"}');
  expect(await promises.readdir(directory)).toEqual(["state.lock"]);
});

it.each(kinds)("%s retains exclusive-create compatibility when publication primitives are unavailable", async kind => {
  let native;
  try { native = __loadBundledNativeForTest(); } catch { configureFsSafeNative({ mode: "off" }); }
  const unsupported = () => { throw Object.assign(new Error("unsupported mount"), { code: "ENOTSUP" }); };
  if (native) __setNativeLoaderForTest(() => ({ ...native, renameNoReplace: unsupported, linkBeneath: unsupported }));
  vi.spyOn(fs, "linkSync").mockImplementation(unsupported);
  const target = path.join(await tempRoot("fs-safe-no-links-"), "state");
  let publicationAttempts = 0;
  __setFsSafeTestHooksForTest({ beforeSidecarLockPublish() { publicationAttempts++; } });
  const lock = await acquire(target, kind);
  try {
    expect(publicationAttempts).toBe(1);
    expect(JSON.parse(await promises.readFile(`${target}.lock`, "utf8")).owner).toBe("complete");
    expect(await promises.readdir(path.dirname(target))).toEqual(["state.lock"]);
  } finally { await lock.release(); }
});

it.each(["auto", "off"] as const)("concurrent contenders publish exactly one complete owner (%s)", async mode => {
  configureFsSafeNative({ mode });
  const target = path.join(await tempRoot("fs-safe-contenders-"), "state");
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => acquire(target, i % 2 ? "raw-async" : "root-async", `contender-${i}`)));
  const winners = results.filter(result => result.status === "fulfilled");
  try {
    expect(winners).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(11);
    expect(JSON.parse(await promises.readFile(`${target}.lock`, "utf8")).owner).toBe("complete");
    expect(await promises.readdir(path.dirname(target))).toEqual(["state.lock"]);
  } finally {
    for (const winner of winners) await winner.value.release();
  }
});

it("keeps the placeholder write window on mounts without either publication primitive", async () => {
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }); });
  const target = path.join(await tempRoot("fs-safe-placeholder-"), "state"), lockPath = `${target}.lock`;
  const write = fs.writeFileSync;
  let placeholderObserved = false;
  vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    if (fs.existsSync(lockPath)) {
      placeholderObserved = true;
      expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    }
    return Reflect.apply(write, fs, args);
  });
  const lock = await acquire(target, "raw-sync");
  try {
    expect(placeholderObserved).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner).toBe("complete");
  } finally { await lock.release(); }
});

for (const boundary of ["final-fence", "stage-unlink"] as const) {
  it.each(kinds)(`%s cleans an owned publication when ${boundary} fails`, async kind => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-published-cleanup-");
    const target = path.join(directory, "state"), final = `${target}.lock`;
    const failure = Object.assign(new Error("post-publication failure"), { code: "EIO" });
    const link = fs.linkSync, lstat = fs.lstatSync, unlink = fs.unlinkSync;
    let published = false, injected = false;
    vi.spyOn(fs, "linkSync").mockImplementation((...args) => { link(...args); published = true; });
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (boundary === "final-fence" && published && !injected && args[0] === final) {
        injected = true; throw failure;
      }
      return Reflect.apply(lstat, fs, args);
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(name => {
      if (boundary === "stage-unlink" && published && !injected && String(name).endsWith(".tmp")) {
        injected = true; throw failure;
      }
      return unlink(name);
    });
    await expect(acquire(target, kind)).rejects.toBe(failure);
    expect(injected).toBe(true);
    expect(await promises.readdir(directory)).toEqual([]);
  });
}

it("preserves raw async token ownership when descriptor and pathname identities differ", async () => {
  configureFsSafeNative({ mode: "off" });
  const target = path.join(await tempRoot("fs-safe-stage-drift-"), "state");
  const stat = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
    const actual = Reflect.apply(stat, fs, args);
    return actual.isFile() ? Object.assign(actual, {
      ino: typeof actual.ino === "bigint" ? actual.ino + 100n : actual.ino + 100,
    }) : actual;
  });
  const lock = await acquire(target, "raw-async");
  expect(await lock.verifyStillHeld()).toBe(true);
  await lock.release();
  expect(fs.existsSync(`${target}.lock`)).toBe(false);
});

it.each(kinds)("%s preserves a replacement after a post-publication failure", async kind => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-published-successor-");
  const target = path.join(directory, "state"), final = `${target}.lock`;
  const failure = Object.assign(new Error("post-publication replacement"), { code: "EIO" });
  const link = fs.linkSync, lstat = fs.lstatSync;
  let published = false, replaced = false;
  vi.spyOn(fs, "linkSync").mockImplementation((...args) => { link(...args); published = true; });
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    if (published && !replaced && args[0] === final) {
      replaced = true;
      fs.unlinkSync(final);
      fs.writeFileSync(final, '{"owner":"successor"}', { flag: "wx" });
      throw failure;
    }
    return Reflect.apply(lstat, fs, args);
  });
  await expect(acquire(target, kind)).rejects.toBe(failure);
  expect(replaced).toBe(true);
  expect(await promises.readFile(final, "utf8")).toBe('{"owner":"successor"}');
  expect(await promises.readdir(directory)).toEqual(["state.lock"]);
});
