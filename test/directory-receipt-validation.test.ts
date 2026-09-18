import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinDirectory, syncDirectory, syncDirectorySync, type DirectoryReceipt } from "../src/directory-durability.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("malformed directory receipt admission on Windows", () => {
  it.each([
    ["missing path", { path: undefined }],
    ["numeric path", { path: 42 }],
    ["missing real path", { realPath: undefined }],
    ["non-string real path", { realPath: {} }],
    ["missing identity", { identity: undefined }],
    ["null identity", { identity: null }],
    ["missing identity components", { identity: {} }],
    ["path only", { realPath: undefined, identity: undefined }],
  ] as const)("rejects %s with path-mismatch before filesystem access", async (_name, broken) => {
    const directory = await tempRoot("fs-safe-directory-receipt-shape-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "untouched source");
    const receipt = {
      path: directory,
      realPath: directory,
      identity: await fs.lstat(directory),
      ...broken,
    } as unknown as DirectoryReceipt;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const open = vi.spyOn(fs, "open");
    const openSync = vi.spyOn(fsSync, "openSync");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const link = vi.spyOn(fs, "link");
    const copy = vi.spyOn(fs, "copyFile");

    await expect(pinDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(syncDirectory(receipt)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(() => syncDirectorySync(receipt)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    await expect(publishFileExclusive({ sourcePath, targetPath, parentReceipt: receipt, strategy: "link-required" }))
      .rejects.toMatchObject({ code: "path-mismatch" });

    for (const observation of [open, openSync, lstat, link, copy]) expect(observation).not.toHaveBeenCalled();
    expect(await fs.readFile(sourcePath, "utf8")).toBe("untouched source");
    expect(await fs.readdir(directory)).toEqual(["source"]);
  });
});
