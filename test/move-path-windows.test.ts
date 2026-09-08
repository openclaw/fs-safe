import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { movePathWithCopyFallback } from "../src/move-path.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("movePathWithCopyFallback on Windows", () => {
  it("moves a newly created directory when hardlink rejection requires copy fallback", async () => {
    const base = await tempRoot("fs-safe-move-windows-ctime-");
    const source = path.join(base, "source-dir");
    const dest = path.join(base, "dest-dir");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "copied.txt"), "copied");

    await movePathWithCopyFallback({
      from: source,
      sourceHardlinks: "reject",
      to: dest,
    });

    await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
    await expect(fsp.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves directory junctions during copy fallback", async () => {
    const base = await tempRoot("fs-safe-move-windows-junction-");
    const source = path.join(base, "source-dir");
    const dest = path.join(base, "dest-dir");
    const junctionTarget = path.join(base, "junction-target");
    await fsp.mkdir(source);
    await fsp.mkdir(junctionTarget);
    await fsp.symlink(junctionTarget, path.join(source, "host"), "junction");

    await movePathWithCopyFallback({
      from: source,
      sourceHardlinks: "reject",
      to: dest,
    });

    await expect(fsp.realpath(path.join(dest, "host"))).resolves.toBe(
      await fsp.realpath(junctionTarget),
    );
    await expect(fsp.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
