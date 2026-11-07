import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { createSidecarFile, createSidecarFileSync } from "../src/sidecar-lock-publication.js";
import { tryAcquireSidecarReclaimGuard } from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const nativeAvailable = (() => { try { __loadBundledNativeForTest(); return true; } catch { return false; } })();
const kinds = ["raw-async", "raw-sync", "root-async", "root-sync"] as const;
const modes = ["off", "require"] as const;
const matrix = kinds.flatMap(kind => modes.map(mode => ({ kind, mode })));
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  configureFsSafeNative({ mode: "auto" });
});
function unsupported(code = "ENOTSUP"): never { throw Object.assign(new Error("unsupported publication"), { code }); }
function fallback(mode: typeof modes[number], code = "ENOTSUP") {
  configureFsSafeNative({ mode });
  if (mode === "require") {
    const native = __loadBundledNativeForTest();
    __setNativeLoaderForTest(() => ({ ...native, renameNoReplace: () => unsupported(), linkBeneath: () => unsupported(code) }));
  }
  vi.spyOn(fs, "linkSync").mockImplementation(() => unsupported(code));
}
async function options(directory: string, kind: typeof kinds[number]) {
  return {
    ...(kind.startsWith("root") ? { lockRoot: await root(directory) } : {}),
    payload: () => ({ owner: "winner" }), managerKey: `${kind}-${directory}`,
    retry: { retries: 0 }, timeoutMs: 0, staleMs: 0,
    staleRecovery: "remove-if-unchanged" as const, shouldRemoveStaleLock: vi.fn(() => true),
  };
}

it.for(matrix.flatMap(entry => ["default", "object", "undefined", "strict"].map(parser => ({ ...entry, parser }))))(
  "$kind treats a partial live record as contention ($mode, $parser parser)", async ({ kind, mode, parser }, ctx) => {
  if (mode === "require" && !nativeAvailable) return ctx.skip();
  fallback(mode);
  const directory = await tempRoot("fs-safe-exclusive-partial-");
  const target = path.join(directory, "state"), final = `${target}.lock`;
  const partial = '{"owner":\0\0\0';
  fs.writeFileSync(final, partial, { flag: "wx", mode: 0o600 });
  fs.utimesSync(final, 1, 1);
  const parsePayload = vi.fn((raw: string) => parser === "strict" ? JSON.parse(raw) : parser === "object" ? {} : undefined);
  const opts = { ...await options(directory, kind),
    ...(parser === "default" ? {} : { parsePayload }),
  };
  const attempt = async () => kind.endsWith("async") ? await acquireFileLock(target, opts) : acquireFileLockSync(target, opts);
  await expect(attempt()).rejects.toMatchObject({ code: "file_lock_timeout" });
  expect(opts.shouldRemoveStaleLock).not.toHaveBeenCalled();
  expect(parsePayload).not.toHaveBeenCalled();
  expect(fs.readFileSync(final, "utf8")).toBe(partial);
});

it.for(modes)("exclusive fallback admits one concurrent owner (%s)", async (mode, ctx) => {
  if (mode === "require" && !nativeAvailable) return ctx.skip();
  fallback(mode);
  const directory = await tempRoot("fs-safe-exclusive-race-");
  const target = path.join(directory, "state");
  const capability = await root(directory);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => acquireFileLock(target, {
    ...(i % 2 ? { lockRoot: capability } : {}), managerKey: `exclusive-${directory}-${i}`,
    payload: () => ({ owner: i }), timeoutMs: 0, retry: { retries: 0 }, staleMs: Infinity,
  })));
  const winners = results.filter(result => result.status === "fulfilled");
  try {
    expect(winners).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => result.reason.code)).toEqual(Array(11).fill("file_lock_timeout"));
    expect(await fsp.readdir(directory)).toEqual(["state.lock"]);
  } finally { for (const winner of winners) await winner.value.release(); }
});

it.each(["async", "sync"] as const)("%s surfaces exclusive-create permission errors after a link refusal", async kind => {
  fallback("off", "EPERM");
  const directory = await tempRoot("fs-safe-exclusive-denied-");
  const final = path.join(directory, "state.lock");
  const denied = Object.assign(new Error("directory permission denied"), { code: "EACCES" });
  const open = (name: string) => {
    if (name === final) throw denied;
    return fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  };
  const attempt = async () => kind === "sync" ? createSidecarFileSync(final, "{}", open)
    : await createSidecarFile(final, "{}", name => name === final ? Promise.reject(denied) : fsp.open(name, "wx", 0o600));
  await expect(attempt()).rejects.toBe(denied);
  expect(await fsp.readdir(directory)).toEqual([]);
});

it.each(["EIO", "ENOSPC", "EEXIST"])("does not enter exclusive fallback for a hardlink %s", async code => {
  fallback("off", code);
  const directory = await tempRoot("fs-safe-exclusive-errors-");
  const final = path.join(directory, "state.lock"), open = vi.fn((name: string) => fsp.open(name, "wx", 0o600));
  await expect(createSidecarFile(final, "{}", open)).rejects.toMatchObject({ code });
  expect(open.mock.calls.map(([name]) => name)).not.toContain(final);
  expect(await fsp.readdir(directory)).toEqual([]);
});

it.for(modes)("supported publication never opens the final name (%s)", async (mode, ctx) => {
  if (mode === "require" && !nativeAvailable) return ctx.skip();
  configureFsSafeNative({ mode });
  const directory = await tempRoot("fs-safe-exclusive-not-needed-");
  const final = path.join(directory, "state.lock"), open = vi.fn((name: string) => fsp.open(name, "wx", 0o600));
  const { handle } = await createSidecarFile(final, "{}", open);
  try {
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]![0]).not.toBe(final);
    expect(fs.readFileSync(final, "utf8")).toBe("{}");
  } finally { await handle.close(); }
});

it.each(["EACCES", "EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])(
  "uses exclusive creation for the existing hardlink %s classification", async code => {
  fallback("off", code);
  const directory = await tempRoot("fs-safe-exclusive-classifier-");
  const final = path.join(directory, "state.lock");
  const { handle } = await createSidecarFile(final, "{}", name => fsp.open(name, "wx", 0o600));
  try {
    expect(fs.readFileSync(final, "utf8")).toBe("{}");
    expect(await fsp.readdir(directory)).toEqual(["state.lock"]);
  } finally { await handle.close(); }
});

it.skipIf(!nativeAvailable).each(["EACCES", "EPERM", "EIO", "EEXIST"])("never falls through a native rename %s", async code => {
  configureFsSafeNative({ mode: "require" });
  const native = __loadBundledNativeForTest(), link = vi.fn();
  __setNativeLoaderForTest(() => ({ ...native, renameNoReplace: () => unsupported(code), linkBeneath: link }));
  const directory = await tempRoot("fs-safe-exclusive-rename-error-");
  const final = path.join(directory, "state.lock"), open = vi.fn((name: string) => fsp.open(name, "wx", 0o600));
  await expect(createSidecarFile(final, "{}", open)).rejects.toMatchObject({ code });
  expect(link).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledOnce();
  expect(await fsp.readdir(directory)).toEqual([]);
});

it.each(["async", "sync"] as const)("%s cleans a failed fallback write without touching a successor", async kind => {
  fallback("off");
  const directory = await tempRoot("fs-safe-exclusive-write-error-");
  const final = path.join(directory, "state.lock"), failure = new Error("partial write");
  const write = fs.writeFileSync;
  const open = (name: string) => fs.openSync(name, "wx", 0o600);
  const interrupt = (fd: number) => {
    write(fd, "{");
    // Preserve a successor even when it has the exact bytes of our partial file.
    fs.renameSync(final, path.join(directory, "old"));
    write(final, "{", { flag: "wx" });
    throw failure;
  };
  vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
    if (fs.existsSync(final) && typeof args[0] === "number") interrupt(args[0]);
    return Reflect.apply(write, fs, args);
  });
  const attempt = async () => kind === "sync" ? createSidecarFileSync(final, "{}", open)
    : await createSidecarFile(final, "{}", async name => {
      const handle = await fsp.open(name, "wx", 0o600);
      if (name === final) vi.spyOn(handle, "writeFile").mockImplementation(async () => interrupt(handle.fd));
      return handle;
    });
  await expect(attempt()).rejects.toBe(failure);
  expect(fs.readFileSync(final, "utf8")).toBe("{");
  expect((await fsp.readdir(directory)).sort()).toEqual(["old", "state.lock"]);
});

it.for(modes)("Root reclaim guards use the exclusive fallback (%s)", async (mode, ctx) => {
  if (mode === "require" && !nativeAvailable) return ctx.skip();
  fallback(mode);
  const directory = await tempRoot("fs-safe-exclusive-guard-");
  const guard = await tryAcquireSidecarReclaimGuard(new Set(), path.join(directory, "state.lock.reclaim"), await root(directory));
  expect(guard).toBeDefined();
  await guard!.assertHeld!();
  expect((await fsp.readdir(directory))).toEqual(["state.lock.reclaim"]);
  await guard!.release();
  expect(await fsp.readdir(directory)).toEqual([]);
});

it.each(kinds.flatMap(kind => ["object", "null", "undefined"].map(result => ({ kind, result }))))(
  "$kind retains caller-defined non-JSON legacy reclaim ($result)", async ({ kind, result }) => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-exclusive-legacy-");
  const target = path.join(directory, "state");
  fs.writeFileSync(`${target}.lock`, "pid=123\n");
  const opts = {
    ...await options(directory, kind), timeoutMs: Infinity, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
    parsePayload: (raw: string) => raw.startsWith("pid=")
      ? result === "null" ? null : result === "undefined" ? undefined : { pid: 123 }
      : JSON.parse(raw),
    shouldReclaim: () => true,
  };
  const owner = kind.endsWith("async") ? await acquireFileLock(target, opts) : acquireFileLockSync(target, opts);
  try { expect(await owner.verifyStillHeld()).toBe(true); }
  finally { await owner.release(); }
  expect(opts.shouldRemoveStaleLock).toHaveBeenCalledOnce();
  expect(opts.shouldRemoveStaleLock).toHaveBeenCalledWith(expect.objectContaining({
    payload: result === "null" ? null : result === "undefined" ? undefined : { pid: 123 },
  }));
});
