import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { publishFileExclusive } from "../src/publish-file.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";

allowWindowsFilesystemStalls();
const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

it.each(["absolute", "relative"])("copy publication preserves a dangling %s outside target", async (kind, context) => {
  configureFsSafeNative({ mode: "off" });
  const base = await tempRoot("fs-safe-publish-dangling-");
  const directory = path.join(base, "destination");
  await fs.mkdir(directory);
  const source = path.join(base, "source"), outside = path.join(base, "outside");
  const leaf = path.join(directory, "leaf");
  await fs.writeFile(source, "source bytes");
  const link = await fileSymlinkOrSkip(kind === "absolute" ? outside : path.join("..", "outside"), leaf, context);
  // Select the documented unsupported-hardlink fallback; the subsequent open
  // and copy use the real filesystem, including Windows reparse-point behavior.
  const linking = vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
  await expect(publishFileExclusive({ sourcePath: source, targetPath: leaf, strategy: "link-or-copy" })).rejects.toBeDefined();
  expect(linking).toHaveBeenCalledOnce();
  await expect(fs.lstat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.lstat(leaf)).isSymbolicLink()).toBe(true);
  expect(await fs.readlink(leaf)).toBe(link);
  expect(await fs.readFile(source, "utf8")).toBe("source bytes");
});
