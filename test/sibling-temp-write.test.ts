import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeViaSiblingTempPath } from "../src/sibling-temp.js";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-sibling-write-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("writeViaSiblingTempPath", () => {
  it("writes through a sibling temp file and removes the temp", async () => {
    await withTempDir(async (root) => {
      const targetPath = path.join(root, "out.txt");
      let tempPath = "";

      await writeViaSiblingTempPath({
        rootDir: root,
        targetPath,
        tempPrefix: ".test-output-",
        writeTemp: async (candidate) => {
          tempPath = candidate;
          await fs.writeFile(candidate, "ok", "utf8");
        },
      });

      expect(path.basename(tempPath)).toContain(".test-output-");
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("ok");
      await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("bounds private staging names without changing a valid long destination", async () => {
    await withTempDir(async (root) => {
      const fileName = `${"é".repeat(97)}.json`;
      const targetPath = path.join(root, fileName);
      let stagedName = "";

      await writeViaSiblingTempPath({
        rootDir: root,
        targetPath,
        writeTemp: async (candidate) => {
          stagedName = path.basename(candidate);
          await fs.writeFile(candidate, "ok", "utf8");
        },
      });

      expect(Math.max(
        Buffer.byteLength(stagedName.normalize("NFC")),
        Buffer.byteLength(stagedName.normalize("NFD")),
      )).toBeLessThanOrEqual(255);
      expect(stagedName).toMatch(/\.json\.part$/u);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("ok");
    });
  });

  it("rejects targets outside the root", async () => {
    await withTempDir(async (root) => {
      await expect(
        writeViaSiblingTempPath({
          rootDir: path.join(root, "inner"),
          targetPath: path.join(root, "out.txt"),
          writeTemp: async () => {},
        }),
      ).rejects.toThrow("Target path is outside the allowed root");
    });
  });
});
