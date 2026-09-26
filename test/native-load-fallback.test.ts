import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/index.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

it("keeps guarded JS operations usable after a glibc load failure and rejects native-only moves", async () => {
  const loadFailure = Object.assign(new Error("/lib64/libc.so.6: version 'GLIBC_2.34' not found"), {
    code: "ERR_DLOPEN_FAILED",
  });
  const loader = vi.fn(() => { throw loadFailure; });
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode: "auto" });
  const directory = await tempRoot("fs-safe-glibc-fallback-");
  const scoped = await root(directory);
  await scoped.write("source.txt", "source");
  await expect(scoped.readText("source.txt")).resolves.toBe("source");
  await expect(scoped.write("../escape.txt", "escape")).rejects.toMatchObject({ code: "outside-workspace" });
  await expect(scoped.move("source.txt", "target.txt")).rejects.toMatchObject({ code: "helper-unavailable" });
  await expect(fs.readFile(path.join(directory, "source.txt"), "utf8")).resolves.toBe("source");
  await expect(fs.lstat(path.join(directory, "target.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(loader).toHaveBeenCalledOnce();

  configureFsSafeNative({ mode: "require" });
  await expect(scoped.write("required.txt", "required")).rejects.toMatchObject({ code: "helper-unavailable", cause: loadFailure });
  await expect(fs.lstat(path.join(directory, "required.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(loader).toHaveBeenCalledOnce();
});
