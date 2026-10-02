import fs from "node:fs/promises";
import type { TestContext } from "vitest";

export async function fileSymlinkOrSkip(target: string, leaf: string, context: TestContext): Promise<string> {
  try { await fs.symlink(target, leaf, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("File symlink creation is not permitted by this host or filesystem");
    }
    throw error;
  }
  return await fs.readlink(leaf);
}
