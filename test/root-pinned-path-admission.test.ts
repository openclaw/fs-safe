import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { root, type RootEntriesOptions, type RootMoveOptions } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture() {
  configureFsSafeNative({ mode: "off" });
  const parent = await tempRoot("fs-safe-root-pinned-admission-");
  const directory = path.join(parent, "root");
  await fs.mkdir(path.join(directory, "child"), { recursive: true });
  await fs.writeFile(path.join(directory, "nominal"), "keep nominal");
  await fs.writeFile(path.join(directory, "victim"), "keep victim");
  await fs.writeFile(path.join(parent, "outside"), "keep outside");
  return { parent, directory, capability: await root(directory) };
}

function observeRuntime(mode: "off" | "require" = "require") {
  const loader = vi.fn(() => { throw new Error("rejected paths must not load a backend"); });
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode });
  const calls = [
    vi.spyOn(fsSync, "lstatSync"), vi.spyOn(fsSync, "statSync"),
    vi.spyOn(fs, "lstat"), vi.spyOn(fs, "stat"), vi.spyOn(fs, "open"),
    vi.spyOn(fs, "mkdir"), vi.spyOn(fs, "unlink"), vi.spyOn(fs, "rename"),
    vi.spyOn(fs, "rm"), vi.spyOn(fs, "opendir"), vi.spyOn(fs, "readdir"),
  ];
  return () => {
    expect(loader).not.toHaveBeenCalled();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  };
}

const invalidPaths = [
  { label: "leading traversal", value: "../outside", message: "relative path must not escape root" },
  { label: "internal traversal", value: "child/../victim", message: "relative path must not contain '..'" },
  { label: "NUL", value: "victim\0suffix", message: "relative path contains a NUL byte" },
];

describe.each(["off", "require"] as const)("Root explicit path admission with native mode %s", mode => {
  for (const operation of ["remove", "mkdir"] as const) {
    it.each(invalidPaths)(`${operation} rejects an explicit $label before I/O`, async ({ value, message }) => {
      const { parent, directory, capability } = await fixture();
      const assertUntouched = observeRuntime(mode);
      const assertBeforeMutation = vi.fn();
      const readPath = vi.fn(() => "victim");
      const options = {
        assertBeforeMutation,
        get relativePath() { return readPath(); },
      };

      await expect(capability[operation](value, options))
        .rejects.toMatchObject({ code: "invalid-path", message });

      expect(readPath).toHaveBeenCalledTimes(value.includes("\0") ? 0 : 1);
      expect(assertBeforeMutation).not.toHaveBeenCalled();
      assertUntouched();
      await expect(fs.readFile(path.join(directory, "nominal"), "utf8")).resolves.toBe("keep nominal");
      await expect(fs.readFile(path.join(directory, "victim"), "utf8")).resolves.toBe("keep victim");
      await expect(fs.readFile(path.join(parent, "outside"), "utf8")).resolves.toBe("keep outside");
      expect((await fs.readdir(directory)).sort()).toEqual(["child", "nominal", "victim"]);
    });
  }
});

it.each([
  { label: "source NUL before destination traversal", from: "bad\0source", to: "../target", message: "relative path contains a NUL byte" },
  { label: "destination NUL before source traversal", from: "child/../victim", to: "bad\0target", message: "relative path contains a NUL byte" },
  { label: "leading source traversal before internal destination traversal", from: "../outside", to: "child/../target", message: "relative path must not escape root" },
  { label: "internal source traversal before leading destination traversal", from: "child/../victim", to: "../target", message: "relative path must not contain '..'" },
  { label: "leading destination traversal before options", from: "nominal", to: "../target", message: "relative path must not escape root" },
  { label: "internal destination traversal before options", from: "nominal", to: "child/../target", message: "relative path must not contain '..'" },
])("Root.move preserves $label", async ({ from, to, message }) => {
  const { capability } = await fixture();
  const assertUntouched = observeRuntime();
  const readOptions = vi.fn(() => { throw new Error("invalid move paths must precede option getters"); });
  const options: RootMoveOptions = {
    get overwrite() { return readOptions(); },
    get assertBeforeMutation() { return readOptions(); },
  };
  Object.defineProperty(options, "unknown", { enumerable: true, get: readOptions });

  await expect(capability.move(from, to, options)).rejects.toMatchObject({ code: "invalid-path", message });

  expect(readOptions).not.toHaveBeenCalled();
  assertUntouched();
});

it.each(["budget", "order", "abort"] as const)("Root.entries preserves %s precedence before traversal admission", async fault => {
  const { capability } = await fixture();
  const assertUntouched = observeRuntime();
  const refusal = new Error("iteration cancelled before path admission");
  const options: RootEntriesOptions = {
    signal: AbortSignal.abort(refusal),
    ...(fault === "budget" ? { maxEntries: -1, order: "invalid" as never }
      : fault === "order" ? { order: "invalid" as never } : {}),
  };
  const next = capability.entries("../outside", options).next();

  if (fault === "budget") await expect(next).rejects.toBeInstanceOf(RangeError);
  else if (fault === "order") await expect(next).rejects.toBeInstanceOf(TypeError);
  else await expect(next).rejects.toBe(refusal);
  assertUntouched();
});

it("Root.entries rejects a NUL path synchronously before reading option getters", async () => {
  const { capability } = await fixture();
  const assertUntouched = observeRuntime();
  const readOptions = vi.fn(() => { throw new Error("NUL admission must precede option getters"); });

  expect(() => capability.entries("bad\0path", { get maxEntries() { return readOptions(); } }))
    .toThrowError(expect.objectContaining({ code: "invalid-path", message: "relative path contains a NUL byte" }));
  expect(readOptions).not.toHaveBeenCalled();
  assertUntouched();
});
