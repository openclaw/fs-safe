import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const cases = ["raw-async", "raw-sync", "root-async", "root-sync"] as const;

it.for(cases.flatMap(kind => ["", "{", '{"pid":123}\0'].map(raw => ({ kind, raw }))))(
  "$kind preserves policy diagnostics for an unverifiable owner %j", async ({ kind, raw }) => {
    const directory = await tempRoot("fs-safe-unverifiable-policy-");
    const target = path.join(directory, "state");
    const lockPath = `${target}.lock`;
    fs.writeFileSync(lockPath, raw);
    const before = fs.lstatSync(lockPath, { bigint: true });
    const shouldReclaim = vi.fn(() => true);
    const shouldRemoveStaleLock = vi.fn(() => true);
    const options = {
      payload: () => ({ pid: process.pid }), timeoutMs: 0, retry: { retries: 0 },
      staleRecovery: "remove-if-unchanged" as const, shouldReclaim, shouldRemoveStaleLock,
      ...(kind.startsWith("root") ? { lockRoot: await root(directory) } : {}),
    };
    const acquire = async () => kind.endsWith("async")
      ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
    await expect(acquire()).rejects.toMatchObject({ code: "file_lock_stale" });
    expect(shouldReclaim).toHaveBeenCalledOnce();
    expect(shouldRemoveStaleLock).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
    const after = fs.lstatSync(lockPath, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  },
);

it.for(cases)("%s propagates an unverifiable owner policy failure", async kind => {
  const directory = await tempRoot("fs-safe-unverifiable-policy-error-");
  const target = path.join(directory, "state");
  fs.writeFileSync(`${target}.lock`, "");
  const failure = new Error("inspect the retained owner before retrying");
  const options = {
    payload: () => ({ pid: process.pid }), timeoutMs: 0, retry: { retries: 0 },
    shouldReclaim: () => { throw failure; },
    ...(kind.startsWith("root") ? { lockRoot: await root(directory) } : {}),
  };
  const acquire = async () => kind.endsWith("async")
    ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
  await expect(acquire()).rejects.toBe(failure);
  expect(fs.readFileSync(`${target}.lock`, "utf8")).toBe("");
});
