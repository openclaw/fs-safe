import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { isHardlinkFallbackError, publishFileExclusive } from "../src/durability.js";
import { normalizeLinkError } from "../src/private-producer-handoff.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

it.each(["EACCES", "EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])("classifies %s consistently", code => {
  const error = Object.assign(new Error(code), { code });
  expect(isHardlinkFallbackError(error)).toBe(true);
  expect(normalizeLinkError(error)).toMatchObject({ code: "helper-unavailable", cause: error });
});
it.each(["EIO", "EEXIST", undefined])("does not classify %s as a link refusal", code => {
  expect(isHardlinkFallbackError({ code })).toBe(false);
});

it.each(["link-or-copy", "link-required"] as const)("handles EACCES with %s", async strategy => {
  const directory = await tempRoot("fs-safe-publish-refusal-");
  const sourcePath = path.join(directory, "source");
  const targetPath = path.join(directory, "target");
  await fs.writeFile(sourcePath, "complete bytes");
  const error = Object.assign(new Error("link denied"), { code: "EACCES" });
  vi.spyOn(fs, "link").mockRejectedValue(error);
  const result = publishFileExclusive({ sourcePath, targetPath, strategy });
  if (strategy === "link-required") {
    await expect(result).rejects.toBe(error);
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await expect(result).resolves.toMatchObject({ method: "exclusive-copy" });
    expect(await fs.readFile(targetPath, "utf8")).toBe("complete bytes");
    expect((await fs.stat(targetPath)).ino).not.toBe((await fs.stat(sourcePath)).ino);
  }
  expect(await fs.readFile(sourcePath, "utf8")).toBe("complete bytes");
});
