import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import type { RootContext } from "../src/root-context.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

function watchRootObservations() {
  return [
    vi.spyOn(fsSync, "statSync"),
    vi.spyOn(fsSync, "lstatSync"),
    vi.spyOn(realpathSync, "native"),
  ];
}

const invalidIdentities: Array<{
  name: string;
  make(identity: RootContext["rootIdentity"]): unknown;
}> = [
  { name: "undefined", make: () => undefined },
  { name: "null", make: () => null },
  { name: "primitive", make: () => 1 },
  { name: "empty", make: () => ({}) },
  { name: "numeric", make: ({ dev, ino }) => ({ dev: Number(dev), ino: Number(ino) }) },
  { name: "numeric device", make: ({ dev, ino }) => ({ dev: Number(dev), ino }) },
  { name: "numeric inode", make: ({ dev, ino }) => ({ dev, ino: Number(ino) }) },
  { name: "missing inode", make: ({ dev }) => ({ dev }) },
];

it.each(invalidIdentities)("refuses $name retained identity before reobserving the root", async ({ make }) => {
  const scoped = await root(await tempRoot("fs-safe-root-invalid-identity-"));
  const context: RootContext = Reflect.get(scoped, "context");
  // Simulate corrupted retained state; pathname metadata must not recreate authority.
  Object.defineProperty(context, "rootIdentity", { value: make(context.rootIdentity) });
  const observations = watchRootObservations();
  for (const operation of [() => scoped.resolve("."), () => scoped.stat("."), () => scoped.list(".")]) {
    await expect(operation()).rejects.toMatchObject({
      code: "path-mismatch", message: "root path changed during operation",
    });
  }
  for (const observation of observations) expect(observation).not.toHaveBeenCalled();
});

it("rejects a numeric device before reading the retained inode", async () => {
  const scoped = await root(await tempRoot("fs-safe-root-identity-short-circuit-"));
  const context: RootContext = Reflect.get(scoped, "context");
  const device = Number(context.rootIdentity.dev);
  const reads: string[] = [];
  Object.defineProperties(context.rootIdentity, {
    dev: { get: () => { reads.push("dev"); return device; } },
    ino: { get: () => { reads.push("ino"); throw new Error("inode must not be read"); } },
  });
  const observations = watchRootObservations();
  await expect(scoped.stat(".")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(reads).toEqual(["dev"]);
  for (const observation of observations) expect(observation).not.toHaveBeenCalled();
});

it.each(["dev", "ino"] as const)("preserves %s getter failure ownership before filesystem access", async (field) => {
  const scoped = await root(await tempRoot("fs-safe-root-identity-getter-"));
  const context: RootContext = Reflect.get(scoped, "context");
  const identity = { ...context.rootIdentity };
  const refusal = new Error("retained identity getter failed");
  const reads: string[] = [];
  Object.defineProperties(context.rootIdentity, {
    dev: { get: () => {
      reads.push("dev");
      if (field === "dev") throw refusal;
      return identity.dev;
    } },
    ino: { get: () => { reads.push("ino"); throw refusal; } },
  });
  const observations = watchRootObservations();
  const expectedReads = field === "dev" ? ["dev"] : ["dev", "ino"];
  await expect(scoped.stat(".")).rejects.toBe(refusal);
  expect(reads).toEqual(expectedReads);
  reads.length = 0;
  const failure = await scoped.resolve(".").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FsSafeError);
  expect(failure).toMatchObject({ code: "path-mismatch" });
  expect((failure as FsSafeError).cause).toBe(refusal);
  expect(reads).toEqual(expectedReads);
  for (const observation of observations) expect(observation).not.toHaveBeenCalled();
});

it("keeps high-bit root identities exact across metadata reads and a replacement", async () => {
  const parent = await tempRoot("fs-safe-root-exact-metadata-");
  const directory = path.join(parent, "root");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "value"), "original");
  const originalInode = 9007199254740992n, replacementInode = originalInode + 1n;
  expect(Number(originalInode)).toBe(Number(replacementInode));
  let inode = originalInode;
  for (const method of ["statSync", "lstatSync"] as const) {
    const original = fsSync[method].bind(fsSync);
    vi.spyOn(fsSync, method).mockImplementation((...args) => {
      const stat = original(...args);
      return String(args[0]) === directory
        ? Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? inode : Number(inode) })
        : stat;
    });
  }
  const scoped = await root(directory);
  await expect(scoped.resolve("value")).resolves.toBe(path.join(directory, "value"));
  await expect(scoped.stat("value")).resolves.toMatchObject({ isFile: true, size: 8 });
  await expect(scoped.list(".")).resolves.toEqual(["value"]);
  await fs.rename(directory, path.join(parent, "retained"));
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "value"), "replacement");
  inode = replacementInode;
  for (const operation of [() => scoped.resolve("value"), () => scoped.stat("value"), () => scoped.list(".")]) {
    await expect(operation()).rejects.toMatchObject({ code: "path-mismatch" });
  }
});
