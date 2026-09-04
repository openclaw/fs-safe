import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect, vi } from "vitest";

const copy = fs.cp.bind(fs);
const remove = fs.rm.bind(fs);
let directory: string | undefined;
let pending: Promise<void> | undefined;
let copied = false;
let raced = false;
let copies = 0;

const copySpy = vi.spyOn(fs, "cp").mockImplementation((source, destination, options) => {
  if (typeof destination !== "string" || path.basename(destination) !== "dist"
    || !path.basename(path.dirname(path.dirname(destination))).startsWith("fs-safe-lock-exit-copies-")) {
    return copy(source, destination, options);
  }
  directory = path.dirname(path.dirname(destination));
  copies++;
  pending = (async () => {
    // Exceed the ordinary five-second test deadline, without slowing the child.
    await delay(6_000);
    await copy(source, destination, options);
    copied = true;
  })();
  return pending;
});

const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
  if (target === directory) raced ||= !copied;
  await remove(target, options);
});

afterAll(async () => {
  try {
    // Drain even the deliberately broken baseline before the proof runner exits.
    await pending;
    console.log(JSON.stringify({ slowPackageCopy: { copies, copied, teardownRacedCopy: raced } }));
    expect(copies).toBe(1);
    expect(copied).toBe(true);
    expect(raced).toBe(false);
    await expect(fs.lstat(directory!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    copySpy.mockRestore();
    removeSpy.mockRestore();
    // The failing baseline may recreate files after its own early teardown.
    if (directory) await remove(directory, { recursive: true, force: true });
  }
}, 30_000);
