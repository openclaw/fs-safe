import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import {
  movePathWithCopyFallback,
  type MovePathPublicationReceipt,
} from "../src/atomic.js";
import { itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

itWin32("copies after Windows denies renaming a directory with a real open file", async () => {
  const root = await tempRoot("fs-safe-move-windows-lock-");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const file = path.join(source, "payload.txt");
  await fs.mkdir(source);
  await fs.writeFile(file, "locked source");
  // FileShare.ReadWrite allows copying but withholds FILE_SHARE_DELETE, making
  // Windows itself deny the initial directory rename until this handle closes.
  const locker = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $handle = [IO.File]::Open($env:FS_SAFE_MOVE_LOCK_PATH, 'Open', 'Read', 'ReadWrite')
    try {
      [Console]::Out.WriteLine('locked')
      [Console]::Out.Flush()
      [void][Console]::ReadLine()
    } finally { $handle.Dispose() }
  `], {
    env: { ...process.env, FS_SAFE_MOVE_LOCK_PATH: file },
    timeout: 20000,
  });
  const exited = once(locker, "exit");
  const receipts: MovePathPublicationReceipt[] = [];
  try {
    const [output] = await Promise.race([
      once(locker.stdout, "data"),
      exited.then(() => {
        throw new Error("Windows lock helper exited before opening the file");
      }),
    ]);
    expect(String(output).trim()).toBe("locked");
    const rename = fs.rename;
    let initialError: unknown;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      try {
        await rename(from, to);
      } catch (error) {
        if (from === source) {
          initialError = error;
          locker.stdin.end("\n");
          await exited;
        }
        throw error;
      }
    });
    let authorityChecks = 0;
    await movePathWithCopyFallback({
      from: source,
      to: target,
      assertBeforeMutation: () => {
        authorityChecks++;
      },
      onDestinationPublished: (receipt) => {
        receipts.push(receipt);
      },
    });
    expect(initialError).toMatchObject({ code: "EPERM" });
    expect(authorityChecks).toBe(4);
    expect(receipts).toHaveLength(1);
    const stat = await fs.lstat(target, { bigint: true });
    expect(receipts[0]).toEqual({ path: target, dev: stat.dev, ino: stat.ino });
    await expect(fs.readFile(path.join(target, "payload.txt"), "utf8")).resolves.toBe(
      "locked source",
    );
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (locker.exitCode === null) locker.stdin.end("\n");
    await exited;
  }
}, 30000);
