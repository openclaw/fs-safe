import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { movePathToTrash } from "../src/trash.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("admits a descendant of an explicitly allowed filesystem root", async () => {
  const home = await tempRoot("fs-safe-trash-root-");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const source = path.join(home, "source");
  await fs.writeFile(source, "synthetic bytes");
  const destination = await movePathToTrash(source, { allowedRoots: [path.parse(home).root] });
  expect(path.relative(path.join(home, ".Trash"), destination).startsWith("..")).toBe(false);
  expect(await fs.readFile(destination, "utf8")).toBe("synthetic bytes");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(movePathToTrash(home, { allowedRoots: [home] })).rejects.toThrow("outside allowed roots");
});

it("preserves a long valid basename without overflowing its reservation directory", async () => {
  const home = await tempRoot("fs-safe-trash-long-name-");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const basename = "x".repeat(240);
  const source = path.join(home, basename);
  await fs.writeFile(source, "synthetic bytes");
  const destination = await movePathToTrash(source, { allowedRoots: [home] });
  expect(path.basename(destination)).toBe(basename);
  expect(Buffer.byteLength(path.basename(path.dirname(destination)))).toBeLessThan(255);
  expect(await fs.readFile(destination, "utf8")).toBe("synthetic bytes");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});
