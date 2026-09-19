import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root, type Root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

const cases = [
  { method: "entries", order: "filesystem" },
  { method: "entries", order: "sorted" },
  { method: "walk", order: "filesystem" },
  { method: "walk", order: "sorted" },
] as const;

async function beginIteration(capability: Root, method: "entries" | "walk", order: "filesystem" | "sorted") {
  const iterator = method === "entries"
    ? capability.entries("nested", { order, maxEntries: 33 })
    : capability.walk("nested", { order, maxEntries: 33, symlinkPolicy: "skip" });
  // Sorted walks capture metadata in batches; inspect the next batch's fence.
  const firstBatch = method === "walk" && order === "sorted" ? 32 : 1;
  for (let index = 0; index < firstBatch; index++) await iterator.next();
  return iterator;
}

async function fixture() {
  const base = await tempRoot("fs-safe-stream-identity-");
  const directory = path.join(base, "root");
  const nested = path.join(directory, "nested");
  await fs.mkdir(nested, { recursive: true });
  await Promise.all(Array.from({ length: 33 }, (_, index) =>
    fs.writeFile(path.join(nested, `entry-${String(index).padStart(2, "0")}`), "x")));
  return { directory, nested };
}

it.skipIf(process.platform === "win32").each(cases)(
  "$method $order rechecks safe directory identities without repeated bigint metadata",
  async ({ method, order }) => {
    const f = await fixture();
    const capability = await root(f.directory);
    const iterator = await beginIteration(capability, method, order);
    const original = fsSync.lstatSync.bind(fsSync);
    const observations: boolean[] = [];
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === f.directory || String(args[0]) === f.nested) {
        observations.push(args[1]?.bigint === true);
      }
      return original(...args);
    });
    try {
      expect((await iterator.next()).done).toBe(false);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations).not.toContain(true);
    } finally { await iterator.return(); }
  },
);

it.each(cases)(
  "$method $order rejects a replaced directory whose exact inode rounds to the old inode",
  async ({ method, order }) => {
    const f = await fixture();
    const first = 9007199254740992n;
    const second = first + 1n;
    expect(Number(first)).toBe(Number(second));
    let changed = false;
    const original = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = original(...args);
      if (String(args[0]) !== f.nested) return stat;
      const ino = changed ? second : first;
      return Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
    });
    const iterator = await beginIteration(await root(f.directory), method, order);
    await fs.rename(f.nested, `${f.nested}-original`);
    await fs.mkdir(f.nested);
    await fs.writeFile(path.join(f.nested, "b"), "replacement");
    changed = true;
    await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
  },
);

it.each(cases)(
  "$method $order rejects a replaced root whose exact inode rounds to the old inode",
  async ({ method, order }) => {
    const f = await fixture();
    const first = 9007199254740992n;
    let changed = false;
    for (const operation of ["statSync", "lstatSync"] as const) {
      const original = fsSync[operation].bind(fsSync);
      vi.spyOn(fsSync, operation).mockImplementation((...args) => {
        const stat = original(...args);
        if (String(args[0]) !== f.directory) return stat;
        const ino = changed ? first + 1n : first;
        return Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
      });
    }
    const iterator = await beginIteration(await root(f.directory), method, order);
    await fs.rename(f.directory, `${f.directory}-original`);
    await fs.mkdir(f.nested, { recursive: true });
    await fs.writeFile(path.join(f.nested, "replacement"), "replacement");
    changed = true;
    await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
  },
);

it.each(cases.flatMap(testCase => [false, true].map(recovers => ({ ...testCase, recovers }))))(
  "$method $order bounds unknown Windows directory retries (recovers=$recovers)",
  async ({ method, order, recovers }) => {
    const f = await fixture();
    const iterator = await beginIteration(await root(f.directory), method, order);
    Object.defineProperty(process, "platform", { value: "win32" });
    const original = fsSync.lstatSync.bind(fsSync);
    let attempts = 0;
    const exact: boolean[] = [];
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = original(...args);
      if (String(args[0]) !== f.nested) return stat;
      attempts += 1;
      exact.push(args[1]?.bigint === true);
      if (recovers && attempts > 1) return stat;
      return Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? 0n : 0 });
    });
    try {
      if (recovers) expect((await iterator.next()).done).toBe(false);
      else await expect(iterator.next()).rejects.toMatchObject({ code: "path-mismatch" });
      expect(attempts).toBe(recovers ? (order === "filesystem" ? 4 : 3) : 2);
      expect(exact.every(Boolean)).toBe(true);
    } finally { await iterator.return(); }
  },
);
