import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
allowWindowsFilesystemStalls();
let native;
try { native = __loadBundledNativeForTest(); } catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const cases = process.platform === "win32"
  ? ["control", "root-replaced", "root-moved"] as const
  : ["control", "parent-symlink", "root-replaced", "root-moved"] as const;

describe.skipIf(!native)("retained sidecar release", () => {
beforeEach(() => configureFsSafeNative({ mode: "require" }));
afterEach(() => { configureFsSafeNative({ mode: "auto" }); vi.restoreAllMocks(); });

it.runIf(process.platform === "win32")("settles a Windows ancestor pin before allowing its rename", async () => {
  const base = await tempRoot("sidecar-retained-ancestor-");
  const parent = path.join(base, "parent"), directory = path.join(parent, "data");
  await fs.mkdir(directory, { recursive: true });
  const lock = await acquireFileLock(path.join(directory, "state"), {
    lockRoot: await root(directory), payload: () => ({ owner: "original" }),
  });
  try {
    await expect(fs.rename(parent, `${parent}-moved`)).rejects.toMatchObject({
      code: expect.stringMatching(/^(EPERM|EACCES|EBUSY)$/u),
    });
    await expect(lock.verifyStillHeld()).resolves.toBe(true);
  } finally { await lock.release(); }
  expect(await fs.readdir(directory)).toEqual([]);
  await fs.rename(parent, `${parent}-moved`);
  expect(await fs.readdir(path.join(`${parent}-moved`, "data"))).toEqual([]);
});

it.each(cases)("releases its created sidecar after %s and permits reacquisition", async kind => {
  const base = await tempRoot("sidecar-retained-release-");
  const parent = path.join(base, "parent"), directory = path.join(parent, "data");
  const movedParent = path.join(base, "parent-moved"), movedRoot = path.join(parent, "data-moved");
  await fs.mkdir(directory, { recursive: true });
  const capability = await root(directory);
  const target = path.join(directory, "state.json");
  const lock = await acquireFileLock(target, { lockRoot: capability, payload: () => ({ owner: "original" }) });
  let physical = directory;
  if (kind === "parent-symlink") {
    await fs.rename(parent, movedParent);
    await fs.symlink(movedParent, parent, process.platform === "win32" ? "junction" : "dir");
    physical = path.join(movedParent, "data");
  } else if (kind !== "control") {
    await fs.rename(directory, movedRoot);
    physical = movedRoot;
    if (kind === "root-replaced") await fs.mkdir(directory);
  }
  try {
    if (kind === "control") await expect(lock.verifyStillHeld()).resolves.toBe(true);
    else await expect(lock.verifyStillHeld()).rejects.toMatchObject({
      code: kind === "parent-symlink" ? "outside-workspace" : "path-mismatch",
    });
    await lock.release();
    await lock.release();
    await expect(fs.lstat(path.join(physical, "state.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (kind === "parent-symlink") {
      if (process.platform === "win32") await fs.rmdir(parent);
      else await fs.unlink(parent);
      await fs.rename(movedParent, parent);
    } else if (kind !== "control") {
      if (kind === "root-replaced") await fs.rmdir(directory);
      await fs.rename(movedRoot, directory);
    }
    await lock.release();
  }
  const next = await acquireFileLock(target, {
    lockRoot: await root(directory), timeoutMs: 100, payload: () => ({ owner: "next" }),
  });
  await expect(next.verifyStillHeld()).resolves.toBe(true);
  await next.release();
});

it("never falls back to token-only deletion after retained admission loses its inode", async () => {
  const directory = await tempRoot("sidecar-retained-admission-");
  const capability = await root(directory);
  const target = path.join(directory, "state"), lockPath = `${target}.lock`;
  const open = capability.open.bind(capability);
  let replacement: string | undefined;
  vi.spyOn(capability, "open").mockImplementation(async (...args) => {
    const opened = await open(...args);
    if (replacement === undefined) {
      replacement = await fs.readFile(lockPath, "utf8");
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, replacement);
    }
    return opened;
  });
  await expect(acquireFileLock(target, {
    lockRoot: capability, timeoutMs: 0, payload: () => ({ owner: "original" }),
  })).rejects.toMatchObject({ code: "file_lock_timeout" });
  expect(await fs.readFile(lockPath, "utf8")).toBe(replacement);
});

it.each(["replacement", "same-bytes", "owner-record", "hardlink"] as const)(
  "preserves a sidecar with changed %s and reports the failed check", async kind => {
    const directory = await tempRoot("sidecar-retained-mismatch-");
    const lock = await acquireFileLock(path.join(directory, "state"), {
      lockRoot: await root(directory), payload: () => ({ owner: "original" }),
    });
    const original = await fs.readFile(lock.lockPath, "utf8");
    if (kind === "replacement" || kind === "same-bytes") {
      await fs.rename(lock.lockPath, `${lock.lockPath}.old`);
      await fs.writeFile(lock.lockPath, kind === "same-bytes" ? original : "foreign owner");
    } else if (kind === "owner-record") await fs.writeFile(lock.lockPath, "changed owner");
    else await fs.link(lock.lockPath, `${lock.lockPath}.alias`);
    const expected = await fs.readFile(lock.lockPath, "utf8");
    await expect(lock.release()).rejects.toMatchObject({
      code: "path-mismatch",
      message: expect.stringContaining(kind === "owner-record" ? "owner record" : "identity"),
    });
    expect(await fs.readFile(lock.lockPath, "utf8")).toBe(expected);
  },
);
});
