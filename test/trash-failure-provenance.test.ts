import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { movePathToTrash } from "../src/trash.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const home = await tempRoot("fs-safe-trash-failure-");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const source = path.join(home, "source");
  await fs.writeFile(source, "synthetic bytes");
  return { home, source, move: () => movePathToTrash(source, { allowedRoots: [home] }) };
}

it("retains separate rename fallback and collision observations", async () => {
  const { source, move } = await fixture();
  let codeReads = 0;
  const failure = { get code() { return ++codeReads === 1 ? "EIO" : "EEXIST"; } };
  const rename = vi.spyOn(fsSync, "renameSync").mockImplementationOnce(() => { throw failure; });
  const copy = vi.spyOn(fsSync, "cpSync");
  const destination = await move();
  expect(codeReads).toBe(2);
  expect(rename).toHaveBeenCalledTimes(2);
  expect(copy).not.toHaveBeenCalled();
  expect(await fs.readFile(destination, "utf8")).toBe("synthetic bytes");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["fallback classifier", "collision classifier", "has trap"])(
  "preserves a throwing rename %s without copying or retrying",
  async (stage) => {
    const { source, move } = await fixture();
    const sentinel = Object.assign(new Error("error inspection failed"), { code: "EEXIST" });
    let reads = 0;
    const failure = stage === "has trap"
      ? new Proxy({}, { has() { reads++; throw sentinel; } })
      : { get code() {
          reads++;
          if (stage === "collision classifier" && reads === 1) return "EIO";
          throw sentinel;
        } };
    const rename = vi.spyOn(fsSync, "renameSync").mockImplementation(() => { throw failure; });
    const copy = vi.spyOn(fsSync, "cpSync");
    await expect(move()).rejects.toBe(sentinel);
    expect(reads).toBe(stage === "collision classifier" ? 2 : 1);
    expect(rename).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
    expect(await fs.readFile(source, "utf8")).toBe("synthetic bytes");
  },
);

it.each(["copy", "remove"])("does not reclassify an EXDEV fallback %s failure", async (stage) => {
  const { source, move } = await fixture();
  vi.spyOn(fsSync, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  let codeReads = 0;
  const failure = { get code() { return ++codeReads === 1 ? "EIO" : "EXDEV"; } };
  if (stage === "copy") vi.spyOn(fsSync, "cpSync").mockImplementation(() => { throw failure; });
  else vi.spyOn(fsSync, "rmSync").mockImplementation(() => { throw failure; });
  await expect(move()).rejects.toBe(failure);
  expect(codeReads).toBe(1);
  expect(await fs.readFile(source, "utf8")).toBe("synthetic bytes");
});

it.each([undefined, "non-error copy failure"])("preserves an arbitrary fallback failure (%s)", async (failure) => {
  const { source, move } = await fixture();
  vi.spyOn(fsSync, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  vi.spyOn(fsSync, "cpSync").mockImplementation(() => { throw failure; });
  await expect(move()).rejects.toBe(failure);
  expect(await fs.readFile(source, "utf8")).toBe("synthetic bytes");
});

it("does not retry a throwing fallback collision classifier", async () => {
  const { move } = await fixture();
  const rename = vi.spyOn(fsSync, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
  });
  const sentinel = Object.assign(new Error("fallback error inspection failed"), { code: "EEXIST" });
  let reads = 0;
  vi.spyOn(fsSync, "cpSync").mockImplementation(() => {
    throw { get code() { reads++; throw sentinel; } };
  });
  await expect(move()).rejects.toBe(sentinel);
  expect(reads).toBe(1);
  expect(rename).toHaveBeenCalledOnce();
});
