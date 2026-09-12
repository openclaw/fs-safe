import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

it("pins a relative root spelling before an asynchronous working-directory change", async () => {
  const before = await tempRoot("fs-safe-root-cwd-before-");
  const after = await tempRoot("fs-safe-root-cwd-after-");
  await fs.writeFile(path.join(before, "value"), "before");
  await fs.writeFile(path.join(after, "value"), "after");
  const previous = process.cwd();
  try {
    process.chdir(before);
    const pending = root(".");
    queueMicrotask(() => process.chdir(after));
    const scoped = await pending;
    expect(scoped.rootDir).toBe(before);
    expect(scoped.rootReal).toBe(before);
    await expect(scoped.readAbsolute(path.join(after, "value"))).rejects.toMatchObject({ code: "outside-workspace" });
  } finally { process.chdir(previous); }
});

it("rejects a replacement root whose inode has the same numeric projection", async () => {
  const base = await tempRoot("fs-safe-root-identity-");
  const dir = path.join(base, "root");
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "value"), "original");
  let changed = false;
  const first = 9007199254740992n, second = first + 1n;
  expect(Number(first)).toBe(Number(second));
  for (const method of ["statSync", "lstatSync"] as const) {
    const original = fsSync[method].bind(fsSync);
    vi.spyOn(fsSync, method).mockImplementation((...args) => {
      const stat = original(...args);
      if (String(args[0]) !== dir) return stat;
      const ino = changed ? second : first;
      return Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
    });
  }
  const scoped = await root(dir);
  await fs.rename(dir, path.join(base, "original"));
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "value"), "replacement");
  changed = true;
  await expect(scoped.readText("value")).rejects.toMatchObject({ code: "path-mismatch" });
});

it.each([false, true])("bounds unknown Windows root identity observations (recovers=%s)", async recovers => {
  const dir = await tempRoot("fs-safe-root-unknown-");
  await fs.writeFile(path.join(dir, "value"), "original");
  Object.defineProperty(process, "platform", { value: "win32" });
  const stat = fsSync.statSync.bind(fsSync);
  let attempts = 0;
  vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
    const current = stat(...args);
    if (String(args[0]) !== dir) return current;
    attempts += 1;
    if (recovers && attempts > 1) return current;
    return Object.assign(Object.create(current), {
      dev: typeof current.dev === "bigint" ? 0n : 0,
      ino: typeof current.ino === "bigint" ? 0n : 0,
    });
  });
  if (recovers) {
    const scoped = await root(dir);
    expect(await scoped.readText("value")).toBe("original");
  } else await expect(root(dir)).rejects.toMatchObject({ code: "path-mismatch" });
  expect(attempts).toBe(2);
});
