import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { root, type RootDefaults } from "../src/root.js";
import { captureFileLockSyncRootAuthority } from "../src/file-lock-sync-root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("keeps the documented path fields and defaults as own data properties", async () => {
  const directory = await tempRoot("fs-safe-context-properties-");
  const defaults = { maxBytes: 2 };
  const scoped = await root(directory, defaults);
  const expected = {
    rootDir: path.resolve(directory), rootReal: directory,
    rootWithSep: `${directory}${path.sep}`, defaults,
  };
  for (const [name, value] of Object.entries(expected)) {
    expect(Object.getOwnPropertyDescriptor(scoped, name)).toEqual({
      value, enumerable: true, configurable: true, writable: true,
    });
  }
  expect(scoped.defaults).toBe(defaults);
});

it("retains live default values for later operations without freezing the object", async () => {
  const directory = await tempRoot("fs-safe-context-defaults-");
  await fs.writeFile(path.join(directory, "value"), "payload");
  const defaults: RootDefaults = { maxBytes: 0 };
  const scoped = await root(directory, defaults);
  await expect(scoped.readText("value")).rejects.toMatchObject({ code: "too-large" });
  defaults.maxBytes = 7;
  await expect(scoped.readText("value")).resolves.toBe("payload");
  defaults.maxBytes = 0;
  await expect(scoped.readText("value", { maxBytes: 7 })).resolves.toBe("payload");
  await expect(scoped.readText("value")).rejects.toMatchObject({ code: "too-large" });
  expect(scoped.defaults).toBe(defaults);
  expect(Object.isFrozen(defaults)).toBe(false);
});

it("observes the same live mutation assertion in Root methods and sync-lock capture", async () => {
  const directory = await tempRoot("fs-safe-context-authority-");
  const defaults: RootDefaults = {};
  const scoped = await root(directory, defaults);
  const refusal = new Error("authority revoked");
  const deny = () => { throw refusal; };
  defaults.assertBeforeMutation = deny;
  expect(captureFileLockSyncRootAuthority(scoped).assertBeforeMutation).toBe(deny);
  await expect(scoped.write("value", "payload")).rejects.toBe(refusal);
  await expect(fs.stat(path.join(directory, "value"))).rejects.toMatchObject({ code: "ENOENT" });
  defaults.assertBeforeMutation = undefined;
  expect(captureFileLockSyncRootAuthority(scoped).assertBeforeMutation).toBeUndefined();
  await scoped.write("value", "payload");
  expect(await fs.readFile(path.join(directory, "value"), "utf8")).toBe("payload");
});

it("keeps configured alias reads and both root replacement fences", async () => {
  const base = await tempRoot("fs-safe-context-alias-");
  const directory = path.join(base, "actual"), alias = path.join(base, "alias");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "value"), "original");
  await fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const scoped = await root(alias);
  expect(scoped.rootDir).toBe(alias);
  expect(scoped.rootReal).toBe(directory);
  await expect(scoped.readAbsolute(path.join(alias, "value"))).resolves.toMatchObject({ buffer: Buffer.from("original") });
  await expect(scoped.readAbsolute(path.join(directory, "value"))).resolves.toMatchObject({ buffer: Buffer.from("original") });
  await fs.rename(directory, path.join(base, "retained"));
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "value"), "replacement");
  await expect(scoped.readText("value")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(() => captureFileLockSyncRootAuthority(scoped)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
});

it("does not attach operation state to the retained outer context", async () => {
  const directory = await tempRoot("fs-safe-context-owned-state-");
  const defaults = { durable: false, maxBytes: 32 };
  const scoped = await root(directory, defaults);
  const context = Reflect.get(scoped, "context");
  const initialKeys = Reflect.ownKeys(context);
  Object.freeze(context);
  await scoped.mkdir("nested");
  await scoped.create("nested/first", "one");
  await scoped.write("nested/second", "two");
  const [content, stat, names] = await Promise.all([
    scoped.readText("nested/first"), scoped.stat("nested/second"), scoped.list("nested"),
  ]);
  expect(content).toBe("one");
  expect(stat.isFile).toBe(true);
  expect(names).toEqual(["first", "second"]);
  const walked = [];
  for await (const entry of scoped.walk("nested", { symlinkPolicy: "skip" })) walked.push(entry.relativePath);
  expect(walked).toEqual(["nested/first", "nested/second"]);
  await scoped.remove("nested/first");
  expect(await scoped.exists("nested/first")).toBe(false);
  expect(captureFileLockSyncRootAuthority(scoped).context.rootReal).toBe(directory);
  defaults.maxBytes = 0;
  await expect(scoped.readText("nested/second")).rejects.toMatchObject({ code: "too-large" });
  expect(Reflect.get(scoped, "context")).toBe(context);
  expect(Reflect.ownKeys(context)).toEqual(initialKeys);
});
