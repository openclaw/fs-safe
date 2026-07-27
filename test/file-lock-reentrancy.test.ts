import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireFileLock,
  acquireFileLockSync,
  createFileLockManager,
  withFileLockSync,
} from "../src/file-lock.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function payload(): { pid: number; createdAt: string } {
  return { pid: process.pid, createdAt: new Date().toISOString() };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("owner-scoped file-lock reentrancy", () => {
  it.runIf(process.platform !== "win32")(
    "shares one reference-counted lock across symlinked target paths",
    async () => {
      const root = await tempRoot("fs-safe-reentrant-alias-");
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "link");
      await fs.mkdir(realDir);
      await fs.symlink(realDir, linkDir, "dir");
      const realPath = path.join(realDir, "session.json");
      const linkPath = path.join(linkDir, "session.json");
      const managerKey = `alias-${Date.now()}-${Math.random()}`;
      const reentrantOwner = "session:run-1";
      const first = await acquireFileLock(realPath, {
        managerKey,
        reentrantOwner,
        staleMs: 60_000,
        payload,
      });
      const second = await acquireFileLock(linkPath, {
        managerKey,
        reentrantOwner,
        staleMs: 60_000,
        payload,
      });

      try {
        expect(second.normalizedTargetPath).toBe(first.normalizedTargetPath);
        expect(second.lockPath).toBe(first.lockPath);
        await expect(fs.stat(`${realPath}.lock`)).resolves.toMatchObject({});
        await expect(fs.stat(`${linkPath}.lock`)).resolves.toMatchObject({});
        await first.release();
        await expect(fs.stat(first.lockPath)).resolves.toMatchObject({});
        await second.release();
        await expect(fs.stat(first.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await first.release();
        await second.release();
      }
    },
  );

  it.each([
    ["different", "owner-b"],
    ["absent", undefined],
  ] as const)("queues a %s owner so both read-modify-write operations land", async (_label, secondOwner) => {
    const root = await tempRoot("fs-safe-reentrant-owner-isolation-");
    const targetPath = path.join(root, "state.json");
    await fs.writeFile(targetPath, JSON.stringify({ count: 0 }));
    const manager = createFileLockManager(`owner-isolation-${Date.now()}-${Math.random()}`);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;

    const update = async (owner: string | undefined, wait?: () => Promise<void>): Promise<void> => {
      await manager.withLock(
        targetPath,
        {
          reentrantOwner: owner,
          staleMs: 60_000,
          timeoutMs: 1_000,
          retry: { minTimeout: 1, maxTimeout: 2 },
          payload,
        },
        async () => {
          if (owner !== "owner-a") secondEntered = true;
          const current = JSON.parse(await fs.readFile(targetPath, "utf8")) as { count: number };
          await wait?.();
          await fs.writeFile(targetPath, JSON.stringify({ count: current.count + 1 }));
        },
      );
    };

    const first = update("owner-a", async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = update(secondOwner);
    try {
      await delay(10);
      expect(secondEntered).toBe(false);
    } finally {
      releaseFirst.resolve();
    }
    await Promise.all([first, second]);
    await expect(fs.readFile(targetPath, "utf8").then(JSON.parse)).resolves.toEqual({ count: 2 });
    await manager.drain();
  });

  it("keeps a nested same-owner lock until the last idempotent release", async () => {
    const root = await tempRoot("fs-safe-reentrant-release-");
    const targetPath = path.join(root, "state.json");
    const manager = createFileLockManager(`release-order-${Date.now()}-${Math.random()}`);
    const options = {
      reentrantOwner: "session:run-2",
      staleMs: 60_000,
      payload,
    };
    const outer = await manager.acquire(targetPath, options);
    const inner = await manager.acquire(targetPath, options);

    await inner.release();
    await inner.release();
    await expect(fs.stat(outer.lockPath)).resolves.toMatchObject({});
    await outer.release();
    await expect(fs.stat(outer.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues to arbitrate with a separate process", async () => {
    const root = await tempRoot("fs-safe-reentrant-process-");
    const targetPath = path.join(root, "state.json");
    const lockPath = `${targetPath}.lock`;
    const childCode = `
      const fs = require("node:fs");
      const lockPath = process.argv[1];
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
        process.stdout.write("released\\n");
      });
    `;
    const child = spawn(process.execPath, ["-e", childCode, lockPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const ready = deferred();
    const released = deferred();
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("ready\n")) ready.resolve();
      if (output.includes("released\n")) released.resolve();
    });
    await ready.promise;

    let acquired = false;
    const pending = acquireFileLock(targetPath, {
      managerKey: `cross-process-${Date.now()}-${Math.random()}`,
      reentrantOwner: "parent-operation",
      staleMs: 60_000,
      timeoutMs: 1_000,
      retry: { minTimeout: 1, maxTimeout: 2 },
      payload,
    }).then((lock) => {
      acquired = true;
      return lock;
    });
    await delay(10);
    expect(acquired).toBe(false);
    child.stdin.write("release\n");
    await released.promise;
    const lock = await pending;
    await lock.release();
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
      child.stdin.end();
    });
  });

  it("provides synchronous owner and reference-count parity", async () => {
    const root = await tempRoot("fs-safe-reentrant-sync-");
    const targetPath = path.join(root, "state.json");
    const options = {
      reentrantOwner: "sync-session:run-1",
      staleMs: 60_000,
      timeoutMs: 0,
      retry: { retries: 0 },
      payload,
    };
    const first = acquireFileLockSync(targetPath, options);
    const second = acquireFileLockSync(targetPath, options);

    expect(() =>
      acquireFileLockSync(targetPath, {
        ...options,
        reentrantOwner: "sync-session:other-run",
      }),
    ).toThrow(/timeout/u);
    second.release();
    second.release();
    expect(fsSync.existsSync(first.lockPath)).toBe(true);
    first.release();
    expect(fsSync.existsSync(first.lockPath)).toBe(false);

    withFileLockSync(targetPath, options, () => {
      expect(fsSync.existsSync(first.lockPath)).toBe(true);
      withFileLockSync(targetPath, options, () => {
        expect(fsSync.existsSync(first.lockPath)).toBe(true);
      });
      expect(fsSync.existsSync(first.lockPath)).toBe(true);
    });
    expect(fsSync.existsSync(first.lockPath)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "provides synchronous canonical-alias parity",
    async () => {
      const root = await tempRoot("fs-safe-reentrant-sync-alias-");
      const realDir = path.join(root, "real");
      const linkDir = path.join(root, "link");
      await fs.mkdir(realDir);
      await fs.symlink(realDir, linkDir, "dir");
      const options = {
        reentrantOwner: "sync-session:aliased-run",
        staleMs: 60_000,
        timeoutMs: 0,
        retry: { retries: 0 },
        payload,
      };
      const first = acquireFileLockSync(path.join(realDir, "session.json"), options);
      const second = acquireFileLockSync(path.join(linkDir, "session.json"), options);

      expect(second.normalizedTargetPath).toBe(first.normalizedTargetPath);
      expect(second.lockPath).toBe(first.lockPath);
      first.release();
      expect(fsSync.existsSync(first.lockPath)).toBe(true);
      second.release();
      expect(fsSync.existsSync(first.lockPath)).toBe(false);
    },
  );
});
