import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { readSidecarLockSnapshot } from "../src/sidecar-lock-reclaim.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __setFsSafeTestHooksForTest(); vi.restoreAllMocks(); });

type ProbeMutation = "unlink" | "root" | "parent" | "ancestor" | "canonical" |
  "callback-enoent" | "callback-mismatch";

async function prepareProbeLoss(options: {
  fallback?: boolean;
  kind?: "file" | "directory" | "hardlink";
  replacement?: "file" | "directory" | "hardlink" | "symlink";
  mutation?: ProbeMutation;
} = {}) {
  const mutation = options.mutation ?? "unlink";
  const kind = options.kind ?? "file";
  const base = await tempRoot("sidecar-secondary-probe-");
  const rootPath = path.join(base, "root");
  await fs.mkdir(rootPath);
  const capability = await root(rootPath);
  const ancestor = path.join(capability.rootReal, "ancestor");
  const parent = path.join(ancestor, "parent");
  await fs.mkdir(parent, { recursive: true });
  const relative = "ancestor/parent/state.lock";
  const lockPath = path.join(capability.rootReal, relative);
  const outside = path.join(base, "outside");
  await fs.writeFile(outside, "sentinel");
  await fs.writeFile(lockPath, '{"owner":"original"}');
  let opened: FileHandle | undefined;
  let openFailure: unknown;
  let probeFailure: unknown;
  let probeEntered = false;
  const open = capability.open.bind(capability);
  const stat = capability.stat.bind(capability);
  const probe = vi.spyOn(capability, "stat").mockImplementation(async (...args) => {
    try { return await stat(...args); }
    catch (error) {
      probeFailure = error;
      if (mutation === "canonical") {
        if (options.replacement) await fs.unlink(lockPath);
        await fs.symlink(outside, lockPath);
      }
      throw error;
    }
  });
  vi.spyOn(capability, "open").mockImplementation(async (...args) => {
    try { return await open(...args); }
    catch (error) {
      openFailure = error;
      if (!(error instanceof FsSafeError && error.code === "not-found")) throw error;
      if (kind === "directory") await fs.mkdir(lockPath);
      else {
        await fs.writeFile(lockPath, '{"owner":"successor"}', { flag: "wx" });
        if (kind === "hardlink") await fs.link(lockPath, path.join(base, "successor-link"));
      }
      __setFsSafeTestHooksForTest({
        ...(options.fallback ? { beforeRootStatInitialObservation: () => {} } : {}),
        async beforeRootStatObservation(candidate) {
          if (candidate !== lockPath) return;
          __setFsSafeTestHooksForTest();
          probeEntered = true;
          if (mutation === "callback-enoent") {
            throw Object.assign(new Error("caller lookup failure"), { code: "ENOENT" });
          }
          if (mutation === "callback-mismatch") {
            throw new FsSafeError("path-mismatch", "caller mismatch", {
              cause: Object.assign(new Error("forged missing leaf"), { code: "ENOENT" }),
            });
          }
          // Pin the outgoing inode so a fast replacement cannot reuse its identity.
          const retained = options.replacement ? await fs.open(lockPath, "r") : undefined;
          try {
            if (kind === "directory") await fs.rmdir(lockPath);
            else await fs.unlink(lockPath);
            if (options.replacement === "directory") await fs.mkdir(lockPath);
            else if (options.replacement === "symlink") await fs.symlink(outside, lockPath);
            else if (options.replacement) {
              await fs.writeFile(lockPath, '{"owner":"third"}', { flag: "wx" });
              if (options.replacement === "hardlink") await fs.link(lockPath, path.join(base, "third-link"));
            }
            if (mutation === "root") await fs.rename(rootPath, `${rootPath}.old`);
            if (mutation === "parent") await fs.rename(parent, `${parent}.old`);
            if (mutation === "ancestor") {
              await fs.rename(ancestor, `${ancestor}.old`);
              await fs.mkdir(ancestor);
              await fs.rename(path.join(`${ancestor}.old`, "parent"), parent);
            }
          } finally { await retained?.close(); }
        },
      });
      throw error;
    }
  });
  __setFsSafeTestHooksForTest({ async beforeRootReadFinalFence(candidate, handle) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    opened = handle;
    await fs.unlink(lockPath);
  } });
  return {
    capability, lockPath, relative, outside, probe,
    evidence: () => ({ opened, openFailure, probeFailure, probeEntered }),
  };
}

itPosix.each([false, true].flatMap(fallback =>
  (["unlinked", "changed"] as const).map(discardObservation => ({ fallback, discardObservation } as const))))(
  "discards a successor lost during the $discardObservation metadata probe (fallback=$fallback)",
  async ({ fallback, discardObservation }) => {
    const fixture = await prepareProbeLoss({ fallback });
    const parsePayload = vi.fn(JSON.parse);
    await expect(readSidecarLockSnapshot(fixture.lockPath, {
      lockRoot: fixture.capability, discardObservation, parsePayload,
    })).resolves.toBeNull();

    const evidence = fixture.evidence();
    expect(evidence.openFailure).toMatchObject({ code: "not-found" });
    // Root.stat keeps its public mismatch contract; only the private probe discards it.
    expect(evidence.probeFailure).toMatchObject({ code: "path-mismatch", cause: { code: "ENOENT" } });
    expect(evidence.probeEntered).toBe(true);
    expect(evidence.opened?.fd).toBe(-1);
    expect(fixture.probe).toHaveBeenCalledExactlyOnceWith(fixture.relative);
    expect(parsePayload).not.toHaveBeenCalled();
    await expect(fs.lstat(fixture.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

itPosix.each([
  { mutation: "unlink", kind: "directory" },
  { mutation: "unlink", kind: "hardlink" },
  ...["root", "parent", "ancestor", "canonical", "callback-enoent", "callback-mismatch"]
    .map(mutation => ({ mutation, kind: "file" } as const)),
] as const)("keeps $kind / $mutation probe failures terminal", async ({ mutation, kind }) => {
  const fixture = await prepareProbeLoss({ mutation: mutation as ProbeMutation, kind });
  const parsePayload = vi.fn(JSON.parse);
  let failure: unknown;
  try {
    await readSidecarLockSnapshot(fixture.lockPath, {
      lockRoot: fixture.capability, discardObservation: "changed", parsePayload,
    });
  } catch (error) { failure = error; }

  const evidence = fixture.evidence();
  expect(failure).toBe(evidence.openFailure);
  expect(failure).toMatchObject({ code: "not-found" });
  expect(evidence.probeEntered).toBe(true);
  expect(evidence.opened?.fd).toBe(-1);
  expect(parsePayload).not.toHaveBeenCalled();
  await expect(fs.readFile(fixture.outside, "utf8")).resolves.toBe("sentinel");
});

itPosix.each([false, true].flatMap(fallback =>
  (["unlinked", "changed"] as const).map(discardObservation => ({ fallback, discardObservation } as const))))(
  "discards a successor replaced during the $discardObservation metadata probe (fallback=$fallback)",
  async ({ fallback, discardObservation }) => {
    const fixture = await prepareProbeLoss({ fallback, replacement: "file" });
    const parsePayload = vi.fn(JSON.parse);
    await expect(readSidecarLockSnapshot(fixture.lockPath, {
      lockRoot: fixture.capability, discardObservation, parsePayload,
    })).resolves.toBeNull();
    expect(fixture.evidence().probeFailure).toMatchObject({ code: "path-mismatch" });
    expect(fixture.evidence().opened?.fd).toBe(-1);
    expect(parsePayload).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.lockPath, "utf8")).toBe('{"owner":"third"}');
  },
);

itPosix.each([false, true].flatMap(fallback => [
  { kind: "directory", replacement: "file", mutation: "unlink" },
  { kind: "hardlink", replacement: "file", mutation: "unlink" },
  ...["directory", "hardlink", "symlink"].map(replacement => ({ kind: "file", replacement, mutation: "unlink" })),
  ...["root", "parent", "ancestor", "canonical", "callback-enoent", "callback-mismatch"]
    .map(mutation => ({ kind: "file", replacement: "file", mutation })),
].map(options => ({ ...options, fallback }))))(
  "keeps $kind to $replacement / $mutation probe failures terminal (fallback=$fallback)",
  async ({ fallback, kind, replacement, mutation }) => {
    const fixture = await prepareProbeLoss({
      fallback, kind: kind as "file" | "directory" | "hardlink",
      replacement: replacement as "file" | "directory" | "hardlink" | "symlink", mutation: mutation as ProbeMutation,
    });
    const parsePayload = vi.fn(JSON.parse);
    let failure: unknown;
    try {
      await readSidecarLockSnapshot(fixture.lockPath, {
        lockRoot: fixture.capability, discardObservation: "changed", parsePayload,
      });
    } catch (error) { failure = error; }
    expect(failure).toBe(fixture.evidence().openFailure);
    expect(failure).toMatchObject({ code: "not-found" });
    expect(fixture.evidence().opened?.fd).toBe(-1);
    expect(parsePayload).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.outside, "utf8")).toBe("sentinel");
  },
);

itPosix("charges a lost successor probe to the acquisition retry budget", async () => {
  const fixture = await prepareProbeLoss();
  const target = path.join(fixture.capability.rootReal, "target");
  const manager = createFileLockManager(`secondary-probe-budget:${target}`);
  const create = vi.spyOn(fixture.capability, "create");
  const parsePayload = vi.fn(JSON.parse);
  const shouldReclaim = vi.fn(() => true);
  try {
    await expect(manager.acquire(target, {
      lockRoot: fixture.capability,
      lockPath: fixture.lockPath,
      payload: () => ({ owner: "waiter" }),
      retry: { retries: 0 },
      parsePayload,
      shouldReclaim,
    })).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(fixture.evidence().opened?.fd).toBe(-1);
    expect(manager.heldEntries()).toEqual([]);
    expect(parsePayload).not.toHaveBeenCalled();
    expect(shouldReclaim).not.toHaveBeenCalled();
  } finally {
    await manager.drain();
  }
});
