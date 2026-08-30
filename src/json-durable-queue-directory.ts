import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./directory-durability.js";
import { isPathRelativeEscape } from "./path.js";

export async function syncQueueDirectoryCreation(
  dir: string,
  validationBase: string,
): Promise<void> {
  const baseReal = await fs.realpath(validationBase);
  const targetReal = await fs.realpath(dir);
  const relative = path.relative(baseReal, targetReal);
  if (isPathRelativeEscape(relative)) {
    throw new Error(`durable queue directory escapes validation base: ${dir}`);
  }

  const directories = [baseReal];
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    directories.push(path.join(directories.at(-1)!, segment));
  }

  await syncDirectory(targetReal, { label: "durable queue directory" });
  for (const parent of directories.slice(0, -1).toReversed()) {
    await syncDirectory(parent, { label: "durable queue parent" });
  }
}
