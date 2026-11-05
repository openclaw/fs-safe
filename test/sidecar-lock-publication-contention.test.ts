import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { openSidecarRoot } from "../src/sidecar-lock-root.js";
import { sidecarStagingPath } from "../src/sidecar-lock-staging.js";
import * as timing from "../src/timing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

it.each(["async", "sync"] as const)("Root %s retries a publication hardlink without parsing or reclaiming it", async kind => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-linked-publication-");
  const target = path.join(directory, "state"), final = `${target}.lock`;
  const stage = sidecarStagingPath(final);
  fs.writeFileSync(stage, '{"owner":"publisher"}');
  fs.linkSync(stage, final);
  const parsePayload = vi.fn(JSON.parse), shouldReclaim = vi.fn(() => true);
  const finishPublisher = vi.fn(() => {
    expect(parsePayload).not.toHaveBeenCalled();
    expect(shouldReclaim).not.toHaveBeenCalled();
    expect(fs.statSync(final).nlink).toBe(2);
    fs.unlinkSync(stage);
    fs.unlinkSync(final);
  });
  vi.spyOn(timing, "sleep").mockImplementation(async () => { finishPublisher(); });
  vi.spyOn(timing, "sleepSync").mockImplementation(finishPublisher);
  const options = {
    lockRoot: await root(directory), payload: () => ({ owner: "waiter" }),
    parsePayload, shouldReclaim, staleMs: 0, timeoutMs: Infinity,
    retry: { retries: 1, minTimeout: 1, maxTimeout: 1 },
  };
  const owner = kind === "async" ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
  try {
    expect(finishPublisher).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(final, "utf8"))).toEqual({ owner: "waiter" });
    expect(await owner.verifyStillHeld()).toBe(true);
  } finally { await owner.release(); }
});

it.each(["async", "sync"] as const)("Root %s still rejects a foreign hardlink", async kind => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-foreign-linked-lock-");
  const target = path.join(directory, "state"), final = `${target}.lock`;
  const foreign = path.join(directory, "foreign");
  fs.writeFileSync(foreign, '{"owner":"foreign"}');
  fs.linkSync(foreign, final);
  const options = { lockRoot: await root(directory), payload: () => ({}), retry: { retries: 0 } };
  let error: unknown;
  try {
    if (kind === "async") await acquireFileLock(target, options);
    else acquireFileLockSync(target, options);
  } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: kind === "async" ? "path-alias" : "hardlink" });
  expect(fs.readFileSync(final, "utf8")).toBe('{"owner":"foreign"}');
  expect(fs.statSync(foreign).nlink).toBe(2);
});

it("Root readers discard a linked publication but do not admit it as a held owner", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-linked-reader-");
  const capability = await root(directory), final = path.join(directory, "state.lock");
  const stage = sidecarStagingPath(final);
  fs.writeFileSync(stage, '{"owner":"publisher"}');
  fs.linkSync(stage, final);
  expect(await openSidecarRoot(capability, "state.lock", "changed")).toBeNull();
  await expect(openSidecarRoot(capability, "state.lock")).rejects.toMatchObject({ code: "hardlink" });
  fs.unlinkSync(stage);
  const opened = await openSidecarRoot(capability, "state.lock", "changed");
  expect(opened).not.toBeNull();
  await opened?.handle.close();
});

it("Root sync release preserves a distinct successor during its publication interval", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-linked-successor-");
  const target = path.join(directory, "state"), final = `${target}.lock`;
  const owner = acquireFileLockSync(target, { lockRoot: await root(directory), payload: () => ({ owner: "original" }) });
  const stage = sidecarStagingPath(final), raw = '{"owner":"successor"}';
  fs.writeFileSync(stage, raw);
  const unlink = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation(candidate => {
    unlink(candidate);
    if (candidate === final) fs.linkSync(stage, final);
  });
  expect(() => owner.release()).not.toThrow();
  expect(fs.readFileSync(final, "utf8")).toBe(raw);
  expect(fs.statSync(final).nlink).toBe(2);
});

it("requires current Root mutation authority before cleaning an abandoned publication link", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-linked-authority-");
  const target = path.join(directory, "state"), final = `${target}.lock`;
  const stage = sidecarStagingPath(final);
  fs.writeFileSync(stage, '{"owner":"abandoned"}');
  fs.linkSync(stage, final);
  const failure = new Error("revoked cleanup authority");
  const capability = await root(directory, { assertBeforeMutation() { throw failure; } });
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
  await expect(acquireFileLock(target, { lockRoot: capability, payload: () => ({}) })).rejects.toBe(failure);
  expect(fs.statSync(final).nlink).toBe(2);
  expect(fs.readFileSync(stage, "utf8")).toBe('{"owner":"abandoned"}');
});

it("retries a publication that appears between the two Root create preflight checks", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-linked-late-preflight-");
  const target = path.join(directory, "state"), final = `${target}.lock`;
  const capability = await root(directory), stage = sidecarStagingPath(final);
  fs.writeFileSync(stage, '{"owner":"publisher"}');
  const stat = fs.statSync;
  let published = false;
  vi.spyOn(fs, "statSync").mockImplementation((...args) => {
    if (args[0] === final && args[1]?.throwIfNoEntry === false && !published) {
      published = true;
      fs.linkSync(stage, final);
    }
    return Reflect.apply(stat, fs, args);
  });
  const finish = vi.spyOn(timing, "sleep").mockImplementation(async () => {
    fs.unlinkSync(stage);
    fs.unlinkSync(final);
  });
  const owner = await acquireFileLock(target, {
    lockRoot: capability, payload: () => ({ owner: "waiter" }),
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 }, timeoutMs: Infinity, staleMs: Infinity,
  });
  try {
    expect(published).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(final, "utf8"))).toEqual({ owner: "waiter" });
  } finally { await owner.release(); }
});
