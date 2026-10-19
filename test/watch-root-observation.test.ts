import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { rootHandleContext } from "../src/root-handle-context.js";
import { checkWatchRoot } from "../src/watch-io.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("classifies a Root disappearing between watch observations as an identity failure", async () => {
  const parent = await tempRoot("watch-root-observation-");
  const directory = path.join(parent, "authority");
  const moved = path.join(parent, "original");
  await fsp.mkdir(directory);
  const context = rootHandleContext(await root(directory));
  const lstat = fs.lstatSync;
  let observations = 0;
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options: unknown) => {
    if (String(file).endsWith(path.sep + "authority") && ++observations === 2) {
      fs.renameSync(directory, moved);
    }
    return lstat(file, options as never);
  }) as typeof fs.lstatSync);

  await expect(checkWatchRoot(context)).rejects.toMatchObject({
    code: "path-mismatch", cause: { code: "ENOENT" },
  });
  expect(observations).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(moved)).toBe(true);
  expect(fs.existsSync(directory)).toBe(false);
});
