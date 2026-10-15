import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { writeExternalFileWithinRoot } from "../src/output.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

itPosix.each([undefined, "private-directory"] as const)(
  "rejects a redirected ancestor before the sibling producer runs (%s)", async producerIsolation => {
    const rootDir = await tempRoot("fs-safe-output-admission-");
    const outside = await tempRoot("fs-safe-output-outside-");
    const parent = path.join(rootDir, "a", "b");
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(path.join(outside, "b"));
    const lstat = fs.lstatSync;
    let swapped = false;
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
      if (!swapped && candidate === parent && new Error().stack?.includes("writeCallbackSibling")) {
        swapped = true;
        fs.renameSync(path.join(rootDir, "a"), path.join(rootDir, "retired"));
        fs.symlinkSync(outside, path.join(rootDir, "a"), "dir");
      }
      return lstat(candidate, options);
    }) as typeof fs.lstatSync);
    const write = vi.fn(async (file: string) => { fs.writeFileSync(file, "payload"); });
    await expect(writeExternalFileWithinRoot({
      rootDir, path: "a/b/output.txt", staging: "sibling", producerIsolation, write,
    })).rejects.toMatchObject({ code: expect.stringMatching(/^(path-mismatch|outside-workspace)$/) });
    expect(swapped).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(outside, "b"))).toEqual([]);
    expect(fs.readdirSync(path.join(rootDir, "retired", "b"))).toEqual([]);
  },
);
