import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import { stageArchiveFileForExtraction } from "../src/archive-input.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { readArchiveEntry } from "../src/archive-read.js";
import { readJsonDurableQueueEntry } from "../src/json-durable-queue.js";
import { writeJsonSync } from "../src/json.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { readSecureFile } from "../src/secure-file.js";
import { readSecretFile } from "../src/secret-read-async.js";
import { readSidecarLockSnapshotSync } from "../src/sidecar-lock-reclaim.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function makeFifo(filePath: string): void {
  expect(spawnSync("mkfifo", [filePath]).status).toBe(0);
}

async function swapForFifo(filePath: string): Promise<string> {
  const displaced = `${filePath}.displaced`;
  await fs.rename(filePath, displaced);
  makeFifo(filePath);
  return displaced;
}

function expectNonblocking(flags: string | number): void {
  expect(typeof flags).toBe("number");
  expect(Number(flags) & fsSync.constants.O_NONBLOCK).toBe(fsSync.constants.O_NONBLOCK);
}

function deadline() {
  const signal = new AbortController().signal;
  return {
    signal,
    check: vi.fn(),
    ownDestinationMutation: async <T>(run: () => Promise<T>) => await run(),
    waitForDestinationMutations: async () => undefined,
    dispose: () => undefined,
  };
}

describe("nonblocking regular-file admission", () => {
  itPosix("rejects a secure-file FIFO preview before open", async () => {
    const root = await tempRoot("fs-safe-secure-fifo-preview-");
    const filePath = path.join(root, "secret");
    makeFifo(filePath);
    const open = vi.spyOn(fs, "open");
    await expect(readSecureFile({
      filePath,
      permissions: { allowInsecure: true },
      io: { timeoutMs: 10 },
    })).rejects.toMatchObject({ code: "not-file" });
    expect(open).not.toHaveBeenCalled();
  });

  itPosix("rejects a secure-file FIFO swap before timeout ownership without blocking", async () => {
    const root = await tempRoot("fs-safe-secure-fifo-swap-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      await swapForFifo(filePath);
      return await open(candidate, flags, mode);
    });
    await expect(readSecureFile({
      filePath,
      permissions: { allowInsecure: true },
      io: { timeoutMs: 10 },
    })).rejects.toMatchObject({ code: "not-file" });
  });

  itPosix("keeps allowed-symlink opens nonblocking across a FIFO swap", async () => {
    const root = await tempRoot("fs-safe-secure-fifo-link-");
    const target = path.join(root, "target");
    const filePath = path.join(root, "secret");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    await fs.symlink(target, filePath);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      expect(Number(flags) & fsSync.constants.O_NOFOLLOW).toBe(0);
      await fs.unlink(filePath);
      makeFifo(filePath);
      return await open(candidate, flags, mode);
    });
    await expect(readSecureFile({
      filePath,
      trust: { allowSymlink: true },
      permissions: { allowInsecure: true },
    })).rejects.toMatchObject({ code: "not-file" });
  });

  itPosix("rejects a secret-file FIFO swap without blocking", async () => {
    const root = await tempRoot("fs-safe-secret-fifo-");
    const filePath = path.join(root, "secret");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      await swapForFifo(filePath);
      return await open(candidate, flags, mode);
    });
    await expect(readSecretFile(filePath, "token", { rejectSymlink: true }))
      .rejects.toMatchObject({ code: "path-mismatch" });
  });

  itPosix("rejects an archive extraction input FIFO swap before its deadline can be bypassed", async () => {
    const root = await tempRoot("fs-safe-archive-input-fifo-");
    const archivePath = path.join(root, "archive.zip");
    await fs.writeFile(archivePath, "archive");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      await swapForFifo(archivePath);
      return await open(candidate, flags, mode);
    });
    await expect(stageArchiveFileForExtraction({
      archivePath,
      limits: resolveExtractLimits(),
      deadline: deadline(),
    })).rejects.toThrow("archive changed during validation");
  });

  itPosix("rejects an archive entry-read FIFO swap without blocking", async () => {
    const root = await tempRoot("fs-safe-archive-read-fifo-");
    const archivePath = path.join(root, "archive.zip");
    await fs.writeFile(archivePath, "archive");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      await swapForFifo(archivePath);
      return await open(candidate, flags, mode);
    });
    await expect(readArchiveEntry(archivePath, "entry", { maxBytes: 16, kind: "zip" }))
      .rejects.toThrow("archive changed during validation");
  });

  itPosix("rejects a durable queue FIFO swap without blocking", async () => {
    const root = await tempRoot("fs-safe-queue-fifo-");
    const filePath = path.join(root, "entry.json");
    await fs.writeFile(filePath, JSON.stringify({ ok: true }));
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      await swapForFifo(filePath);
      return await open(candidate, flags, mode);
    });
    await expect(readJsonDurableQueueEntry(filePath)).rejects.toThrow("queue entry is not a regular file");
  });

  itPosix("rejects an exclusive-publication source FIFO swap without blocking", async () => {
    const root = await tempRoot("fs-safe-publish-fifo-");
    const sourcePath = path.join(root, "source");
    const targetPath = path.join(root, "target");
    await fs.writeFile(sourcePath, "source");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      await swapForFifo(sourcePath);
      return await open(candidate, flags, mode);
    });
    await expect(publishFileExclusive({
      sourcePath,
      targetPath,
      strategy: "link-required",
    })).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("does not chmod a FIFO swapped into a synchronous JSON target", async () => {
    const root = await tempRoot("fs-safe-json-fifo-");
    const filePath = path.join(root, "state.json");
    const displaced = `${filePath}.displaced`;
    const openSync = fsSync.openSync.bind(fsSync);
    const fchmodSync = fsSync.fchmodSync.bind(fsSync);
    let fifoFd = -1;
    let fifoChmods = 0;
    vi.spyOn(fsSync, "openSync").mockImplementation((candidate, flags, mode) => {
      if (String(candidate) === filePath && typeof flags === "number") {
        expectNonblocking(flags);
        fsSync.renameSync(filePath, displaced);
        makeFifo(filePath);
        fifoFd = openSync(candidate, flags, mode);
        return fifoFd;
      }
      return openSync(candidate, flags, mode);
    });
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      if (fd === fifoFd) fifoChmods += 1;
      return fchmodSync(fd, mode);
    });

    writeJsonSync(filePath, { ok: true });

    expect(fifoChmods).toBe(0);
    expect(fsSync.lstatSync(filePath).isFIFO()).toBe(true);
    expect(JSON.parse(fsSync.readFileSync(displaced, "utf8"))).toEqual({ ok: true });
  });

  itPosix("does not chmod a regular file swapped into a synchronous JSON target", async () => {
    const root = await tempRoot("fs-safe-json-regular-swap-");
    const filePath = path.join(root, "state.json");
    const displaced = `${filePath}.displaced`;
    const openSync = fsSync.openSync.bind(fsSync);
    const fchmodSync = fsSync.fchmodSync.bind(fsSync);
    let replacementFd = -1;
    let replacementChmods = 0;
    vi.spyOn(fsSync, "openSync").mockImplementation((candidate, flags, mode) => {
      if (String(candidate) === filePath && typeof flags === "number") {
        fsSync.renameSync(filePath, displaced);
        fsSync.writeFileSync(filePath, "foreign", { mode: 0o644 });
        fsSync.chmodSync(filePath, 0o644);
        replacementFd = openSync(candidate, flags, mode);
        return replacementFd;
      }
      return openSync(candidate, flags, mode);
    });
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
      if (fd === replacementFd) replacementChmods += 1;
      return fchmodSync(fd, mode);
    });

    writeJsonSync(filePath, { ok: true });

    expect(replacementChmods).toBe(0);
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("foreign");
    expect(fsSync.statSync(filePath).mode & 0o777).toBe(0o644);
    expect(JSON.parse(fsSync.readFileSync(displaced, "utf8"))).toEqual({ ok: true });
  });

  itPosix("rejects a synchronous sidecar-lock FIFO swap without blocking", async () => {
    const root = await tempRoot("fs-safe-sidecar-fifo-");
    const lockPath = path.join(root, "entry.lock");
    fsSync.writeFileSync(lockPath, "{}");
    const openSync = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementationOnce((candidate, flags, mode) => {
      expectNonblocking(flags);
      fsSync.renameSync(lockPath, `${lockPath}.displaced`);
      makeFifo(lockPath);
      return openSync(candidate, flags, mode);
    });
    expect(() => readSidecarLockSnapshotSync(lockPath, undefined, { rejectNonFile: true }))
      .toThrow(expect.objectContaining({ code: "not-file" }));
  });
});
