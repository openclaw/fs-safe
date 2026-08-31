import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pauseSidecarSnapshotOpen } from "./helpers/sidecar-snapshot.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { FsSafeError } from "../src/errors.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import {
  parseSidecarLockPayload,
  readSidecarLockSnapshot,
  readSidecarLockSnapshotSync,
  releaseSidecarReclaimGuard,
  removeSidecarLockIfUnchanged,
  removeSidecarLockIfUnchangedSync,
  removeStaleSidecarLockIfAllowed,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
  sidecarLockSnapshotStillPresent,
  sidecarReclaimGuardExists,
  tryAcquireSidecarReclaimGuard,
} from "../src/sidecar-lock-reclaim.js";
import {
  computeSidecarLockDelayMs,
  defaultSidecarLockShouldReclaim,
  sidecarLockPayloadCreatedAtMs,
  sidecarLockPayloadIsStale,
} from "../src/sidecar-lock-policy.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

describe("sidecar lock helper failure handling", () => {
  it("parses only object payloads unless an application parser is supplied", () => {
    expect(parseSidecarLockPayload('{"owner":"one"}')).toEqual({ owner: "one" });
    expect(parseSidecarLockPayload("[]")).toBeNull();
    expect(parseSidecarLockPayload("null")).toBeNull();
    expect(parseSidecarLockPayload("{" )).toBeNull();
    expect(parseSidecarLockPayload("legacy=7", (raw) => ({ raw }))).toEqual({ raw: "legacy=7" });
  });

  it("treats missing snapshots as absent but rejects non-file state on request", async () => {
    const root = await tempRoot("fs-safe-sidecar-snapshot-helper-");
    const missing = path.join(root, "missing.lock");
    const directory = path.join(root, "directory.lock");
    await fs.mkdir(directory);

    await expect(readSidecarLockSnapshot(missing)).resolves.toBeNull();
    expect(readSidecarLockSnapshotSync(missing)).toBeNull();
    await expect(readSidecarLockSnapshot(directory)).resolves.toBeNull();
    expect(readSidecarLockSnapshotSync(directory)).toBeNull();
    await expect(
      readSidecarLockSnapshot(directory, { rejectNonFile: true }),
    ).rejects.toMatchObject({ code: "not-file" });
    expect(() => readSidecarLockSnapshotSync(directory, undefined, { rejectNonFile: true }))
      .toThrow(expect.objectContaining({ code: "not-file" }));
  });

  it("removes a lock only while the observed snapshot still matches", async () => {
    const root = await tempRoot("fs-safe-sidecar-remove-helper-");
    const lockPath = path.join(root, "state.lock");
    const { raw } = serializeSidecarLockPayload({ owner: "one" });
    await fs.writeFile(lockPath, raw);
    const snapshot = await readSidecarLockSnapshot(lockPath);
    expect(snapshot).not.toBeNull();
    expect(await sidecarLockSnapshotStillPresent(lockPath, snapshot)).toBe(true);
    expect(await sidecarLockSnapshotStillPresent(lockPath, null)).toBe(false);

    await fs.writeFile(lockPath, "replacement");
    expect(await removeSidecarLockIfUnchanged(lockPath, snapshot)).toBe(false);
    expect(removeSidecarLockIfUnchangedSync(lockPath, snapshot!)).toBe(false);
    await fs.writeFile(lockPath, raw);
    const current = readSidecarLockSnapshotSync(lockPath);
    expect(removeSidecarLockIfUnchangedSync(lockPath, current!)).toBe(true);
    expect(fsSync.existsSync(lockPath)).toBe(false);
  });

  itPosix.each([false, true])(
    "treats an unlinked Root snapshot as absent (after identity check: %s)",
    async (afterIdentityCheck) => {
      const capability = await root(await tempRoot("fs-safe-sidecar-root-unlinked-"));
      const relative = "owner.json";
      const lockPath = path.join(capability.rootReal, relative);
      await capability.create(relative, '{"owner":"original"}');
      const probe = vi.spyOn(capability, "stat");
      const gate = pauseSidecarSnapshotOpen(lockPath, afterIdentityCheck);
      const snapshot = readSidecarLockSnapshot(lockPath, { lockRoot: capability });
      const result = expect(snapshot).resolves.toBeNull();
      const handle = await gate.opened;
      const close = vi.spyOn(handle, "close");
      try {
        __setFsSafeTestHooksForTest();
        await capability.remove(relative);
      } finally {
        gate.resume();
      }
      await result;
      expect(close).toHaveBeenCalledTimes(1);
      expect(handle.fd).toBe(-1);
      if (afterIdentityCheck) expect(probe).toHaveBeenCalledExactlyOnceWith(relative);
    },
  );

  itPosix("rejects a Root snapshot replacement without changing either file", async () => {
    const capability = await root(await tempRoot("fs-safe-sidecar-root-replaced-"));
    const lockPath = path.join(capability.rootReal, "owner.json");
    const displacedPath = `${lockPath}.old`;
    const original = '{"owner":"original"}\n';
    const replacement = '{"owner":"replacement"}\n';
    await capability.create("owner.json", original);
    const probe = vi.spyOn(capability, "stat");
    const gate = pauseSidecarSnapshotOpen(lockPath, false);
    const snapshot = readSidecarLockSnapshot(lockPath, { lockRoot: capability });
    const result = expect(snapshot).rejects.toMatchObject({ code: "path-mismatch" });
    const handle = await gate.opened;
    try {
      __setFsSafeTestHooksForTest();
      await fs.rename(lockPath, displacedPath);
      await capability.create("owner.json", replacement);
    } finally {
      gate.resume();
    }
    await result;
    expect(probe).toHaveBeenCalledExactlyOnceWith("owner.json");
    expect(handle.fd).toBe(-1);
    await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe(original);
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(replacement);
  });

  it.each([
    new FsSafeError("path-mismatch", "root changed"),
    new FsSafeError("symlink", "symlink blocked"),
    new FsSafeError("not-file", "not a file"),
    new FsSafeError("hardlink", "hardlink blocked"),
    Object.assign(new Error("missing without capability proof"), { code: "ENOENT" }),
    Object.assign(new Error("probe denied"), { code: "EACCES" }),
  ])("preserves the original mismatch when the Root absence probe rejects with $code", async (failure) => {
    const capability = await root(await tempRoot("fs-safe-sidecar-root-probe-"));
    const mismatch = new FsSafeError("path-mismatch", "opened path changed");
    vi.spyOn(capability, "open").mockRejectedValueOnce(mismatch);
    const probe = vi.spyOn(capability, "stat").mockRejectedValueOnce(failure);
    await expect(readSidecarLockSnapshot(path.join(capability.rootReal, "owner.json"), {
      lockRoot: capability,
    })).rejects.toBe(mismatch);
    expect(probe).toHaveBeenCalledExactlyOnceWith("owner.json");
  });

  itPosix("rejects absence under a replaced Root after the ownership record is unlinked", async () => {
    const base = await tempRoot("fs-safe-sidecar-root-swap-");
    const rootPath = path.join(base, "locks");
    await fs.mkdir(rootPath);
    const capability = await root(rootPath);
    const lockPath = path.join(capability.rootReal, "owner.json");
    await capability.create("owner.json", '{"owner":"original"}');
    const probe = vi.spyOn(capability, "stat");
    const gate = pauseSidecarSnapshotOpen(lockPath, true);
    const snapshot = readSidecarLockSnapshot(lockPath, { lockRoot: capability });
    const result = expect(snapshot).rejects.toMatchObject({ code: "path-mismatch" });
    const handle = await gate.opened;
    try {
      __setFsSafeTestHooksForTest();
      await capability.remove("owner.json");
      await fs.rename(rootPath, `${rootPath}.old`);
      await fs.mkdir(rootPath);
    } finally {
      gate.resume();
    }
    await result;
    expect(probe).toHaveBeenCalledExactlyOnceWith("owner.json");
    expect(handle.fd).toBe(-1);
  });

  it("covers identity, raw, token, and stat-only snapshot comparisons", async () => {
    const root = await tempRoot("fs-safe-sidecar-match-helper-");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await fs.writeFile(first, "one");
    await fs.writeFile(second, "two");
    // Windows can report zero as an unknown file identity, so use known,
    // distinct receipts for this pure snapshot-comparison unit test.
    const firstStat = Object.assign(await fs.stat(first), { dev: 1, ino: 1 });
    const secondStat = Object.assign(await fs.stat(second), { dev: 2, ino: 2 });
    expect(sidecarLockSnapshotMatches({ payload: null, stat: secondStat }, { payload: null, stat: firstStat })).toBe(false);
    expect(sidecarLockSnapshotMatches({ payload: null, raw: "one" }, { payload: null, raw: "one" })).toBe(true);
    expect(sidecarLockSnapshotMatches({ payload: null, raw: "two" }, { payload: null, raw: "one" })).toBe(false);
    expect(sidecarLockSnapshotMatches({ payload: null, stat: firstStat }, { payload: null, stat: firstStat })).toBe(true);
    expect(sidecarLockSnapshotMatches({ payload: null }, { payload: null })).toBe(false);

    const serialized = serializeSidecarLockPayload({ owner: "token" });
    const observed = { payload: null, raw: serialized.raw, ownershipToken: serialized.ownershipToken };
    expect(sidecarLockSnapshotMatches({ payload: null, raw: serialized.raw, stat: firstStat }, observed)).toBe(true);
    expect(sidecarLockSnapshotMatches({ payload: null, raw: `${serialized.raw}x`, stat: firstStat }, observed)).toBe(false);
  });

  it("fails closed on reclaim-guard inspection and creation errors", async () => {
    const root = await tempRoot("fs-safe-sidecar-guard-helper-");
    const guard = path.join(root, "state.lock.reclaim");
    const guards = new Set<string>();
    await expect(sidecarReclaimGuardExists(guard)).resolves.toBe(false);
    await expect(tryAcquireSidecarReclaimGuard(guards, guard)).resolves.toBe(true);
    await expect(sidecarReclaimGuardExists(guard)).resolves.toBe(true);
    await expect(tryAcquireSidecarReclaimGuard(guards, guard)).resolves.toBe(false);
    await releaseSidecarReclaimGuard(guards, guard);
    expect(guards.has(guard)).toBe(false);

    const denied = Object.assign(new Error("guard denied"), { code: "EACCES" });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(denied);
    await expect(sidecarReclaimGuardExists(guard)).rejects.toBe(denied);
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(denied);
    await expect(tryAcquireSidecarReclaimGuard(guards, guard)).rejects.toBe(denied);
  });

  it("requires explicit stale removal approval and detects both replacement races", async () => {
    const root = await tempRoot("fs-safe-sidecar-stale-helper-");
    const lockPath = path.join(root, "state.lock");
    await fs.writeFile(lockPath, "old");
    const snapshot = await readSidecarLockSnapshot(lockPath);
    const base = { lockPath, normalizedTargetPath: path.join(root, "state"), snapshot: snapshot! };

    await expect(removeStaleSidecarLockIfAllowed(base)).resolves.toBe("not-approved");
    await expect(
      removeStaleSidecarLockIfAllowed({ ...base, shouldRemoveStaleLock: () => false }),
    ).resolves.toBe("not-approved");
    await fs.writeFile(lockPath, "changed");
    await expect(
      removeStaleSidecarLockIfAllowed({ ...base, shouldRemoveStaleLock: () => true }),
    ).resolves.toBe("changed");

    await fs.writeFile(lockPath, "old");
    const second = await readSidecarLockSnapshot(lockPath);
    await expect(
      removeStaleSidecarLockIfAllowed({
        ...base,
        snapshot: second!,
        shouldRemoveStaleLock: async () => {
          await fs.writeFile(lockPath, "replacement");
          return true;
        },
      }),
    ).resolves.toBe("changed");
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("replacement");
  });

  it("classifies a vanished stale lock as changed and propagates other removal failures", async () => {
    const root = await tempRoot("fs-safe-sidecar-stale-remove-helper-");
    const lockPath = path.join(root, "state.lock");
    await fs.writeFile(lockPath, "old");
    const snapshot = await readSidecarLockSnapshot(lockPath);
    const params = {
      lockPath,
      normalizedTargetPath: path.join(root, "state"),
      snapshot: snapshot!,
      shouldRemoveStaleLock: () => true,
    };
    vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
    await expect(removeStaleSidecarLockIfAllowed(params)).resolves.toBe("changed");
    vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(removeStaleSidecarLockIfAllowed(params)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("covers retry policy boundaries and fail-closed timestamp fallback", async () => {
    expect(computeSidecarLockDelayMs({ minTimeout: 2, maxTimeout: 5, factor: 2 }, 0)).toBe(2);
    expect(computeSidecarLockDelayMs({ minTimeout: 2, maxTimeout: 5, factor: 2 }, 3)).toBe(5);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(computeSidecarLockDelayMs({ minTimeout: 2, maxTimeout: 10, randomize: true }, 0)).toBe(3);
    expect(sidecarLockPayloadCreatedAtMs({ createdAt: "2000-01-01T00:00:00.000Z" })).toBeTypeOf("number");
    expect(sidecarLockPayloadCreatedAtMs({ createdAt: "invalid" })).toBeNull();
    expect(sidecarLockPayloadCreatedAtMs(null)).toBeNull();
    expect(sidecarLockPayloadIsStale({ createdAt: "2000-01-01T00:00:00.000Z" }, 1, Date.now())).toBe(true);
    expect(sidecarLockPayloadIsStale({}, 1, Date.now())).toBe(false);

    const missing = path.join(await tempRoot("fs-safe-sidecar-policy-"), "missing.lock");
    await expect(defaultSidecarLockShouldReclaim({ lockPath: missing, payload: {}, staleMs: 60_000, nowMs: Date.now() })).resolves.toBe(true);
  });

  it("rejects a snapshot whose opened descriptor is not a regular file", async () => {
    const rootDir = await tempRoot("fs-safe-sidecar-opened-type-");
    const lockPath = path.join(rootDir, "state.lock");
    await fs.writeFile(lockPath, "{}");
    const directoryStat = await fs.stat(rootDir);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "stat").mockResolvedValueOnce(directoryStat);
      return handle;
    });
    await expect(readSidecarLockSnapshot(lockPath)).resolves.toBeNull();

    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      vi.spyOn(handle, "stat").mockResolvedValueOnce(directoryStat);
      return handle;
    });
    await expect(readSidecarLockSnapshot(lockPath, { rejectNonFile: true }))
      .rejects.toMatchObject({ code: "not-file" });
  });

  it("removes an approved stale lock through a Root capability", async () => {
    const rootDir = await tempRoot("fs-safe-sidecar-root-remove-");
    const capability = await root(rootDir);
    const lockPath = path.join(rootDir, "state.lock");
    await capability.create("state.lock", "old");
    const snapshot = await readSidecarLockSnapshot(lockPath, { lockRoot: capability });
    await expect(removeStaleSidecarLockIfAllowed({
      lockPath,
      normalizedTargetPath: path.join(rootDir, "state"),
      snapshot: snapshot!,
      lockRoot: capability,
      shouldRemoveStaleLock: () => true,
    })).resolves.toBe("removed");
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
