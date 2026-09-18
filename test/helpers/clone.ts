import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "vitest";
import { createCloneSource, probeTreeClone } from "../../src/copy.js";

export async function cloneFixture(context: TestContext, tempDirs: string[]) {
  const explicitParent = process.env.FS_SAFE_CLONE_TEST_ROOT;
  const parent = await fs.realpath(explicitParent ?? os.tmpdir());
  const backend = probeTreeClone(parent);
  if (!backend) {
    if (explicitParent) throw new Error("FS_SAFE_CLONE_TEST_ROOT requires native clone support");
    context.skip("native APFS, Btrfs, ReFS, XFS, or ZFS volume unavailable");
    throw new Error("unreachable");
  }
  const directory = await fs.mkdtemp(path.join(parent, "fs-safe-clone-"));
  tempDirs.push(directory);
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination-é space");
  await createCloneSource(source);
  return { directory, source, destination, backend };
}
