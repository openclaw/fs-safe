import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
it.each(["", ".", "./", "sub/..", "sub/../", "./sub/.."])("normalizes the starting spelling %j once", async start => {
  const directory = await tempRoot("fs-safe-walk-prefix-");
  await fs.mkdir(path.join(directory, "sub"));
  await fs.writeFile(path.join(directory, "entry"), "x");
  const capability = await root(directory);
  expect((await Array.fromAsync(capability.walk(start, { symlinkPolicy: "skip" })))
    .map(entry => entry.relativePath)).toEqual(["entry", "sub"]);
});
it.each(["sub", "sub/", "sub///", "./sub", "sub/../sub"])("keeps children beneath %j", async start => {
  const directory = await tempRoot("fs-safe-walk-prefix-");
  await fs.mkdir(path.join(directory, "sub"));
  await fs.writeFile(path.join(directory, "sub", "entry"), "x");
  const capability = await root(directory);
  expect((await Array.fromAsync(capability.walk(start, { symlinkPolicy: "skip" })))
    .map(entry => entry.relativePath)).toEqual(["sub/entry"]);
});
