import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inheritWriteTargetMode } from "../src/root-write-mode.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

it.each([false, true])("verifies unknown Windows opened identity before inheriting mode (recovers=%s)", async recovers => {
  const dir = await tempRoot("fs-safe-write-mode-identity-");
  const targetPath = path.join(dir, "target");
  await fs.writeFile(targetPath, "existing bytes", { mode: 0o600 });
  Object.defineProperty(process, "platform", { value: "win32" });
  let opened: fs.FileHandle | undefined;
  const open = fs.open.bind(fs), fstat = fsSync.fstatSync.bind(fsSync);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === targetPath) opened = handle;
    return handle;
  });
  let inspections = 0;
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
    const stat = fstat(...args);
    if (args[0] !== opened?.fd) return stat;
    inspections += 1;
    if (recovers && inspections > 1) return stat;
    return Object.assign(Object.create(stat), { dev: 0n, ino: 0n });
  });
  const mode = inheritWriteTargetMode({ targetPath, rootWithSep: dir + path.sep });
  if (recovers) await expect(mode).resolves.toBe(0o600);
  else await expect(mode).rejects.toMatchObject({ code: "path-mismatch" });
  expect(inspections).toBe(2);
  expect(opened?.fd).toBe(-1);
  expect(await fs.readFile(targetPath, "utf8")).toBe("existing bytes");
});
