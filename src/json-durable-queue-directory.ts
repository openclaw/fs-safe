import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./directory-durability.js";
import { isPathRelativeEscape } from "./path.js";

export async function syncQueueDirectoryCreation(
  dir: string,
  validationBase: string,
  createdDir: string | undefined,
  syncExisting: boolean,
): Promise<void> {
  if (!syncExisting && createdDir === undefined) return;
  const baseReal = await fs.realpath(validationBase);
  const targetReal = await fs.realpath(dir);
  const relative = path.relative(baseReal, targetReal);
  if (isPathRelativeEscape(relative)) {
    throw new Error(`durable queue directory escapes validation base: ${dir}`);
  }

  let current = baseReal;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    await syncDirectory(current, { label: "durable queue parent" });
    current = path.join(current, segment);
  }
  await syncDirectory(targetReal, { label: "durable queue directory" });
}
