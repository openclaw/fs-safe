import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import { writeExternalFileWithinRoot } from "../src/output.js";

const { tempRoot } = useTempDirs();



describe("writeExternalFileWithinRoot", () => {
  it("stages an external writer in private temp storage and finalizes under the root", async () => {
    const rootDir = await tempRoot("fs-safe-output-root-");
    const targetPath = path.join(rootDir, "downloads", "report.txt");
    let tempPath = "";

    const result = await writeExternalFileWithinRoot({
      rootDir,
      path: targetPath,
      write: async (candidate) => {
        tempPath = candidate;
        await fs.writeFile(candidate, "downloaded", "utf8");
        return { bytes: 10 };
      },
    });

    expect(result.path).toBe(path.join(await fs.realpath(rootDir), "downloads", "report.txt"));
    expect(result.result).toEqual({ bytes: 10 });
    expect(path.dirname(tempPath)).not.toBe(path.dirname(targetPath));
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("downloaded");
    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages beside the target and atomically replaces an existing file", async () => {
    const rootDir = await tempRoot("fs-safe-output-sibling-");
    const targetDir = path.join(rootDir, "downloads");
    const targetPath = path.join(targetDir, "report.txt");
    await fs.mkdir(targetDir);
    await fs.writeFile(targetPath, "old", "utf8");
    let stagedPath = "";

    const result = await writeExternalFileWithinRoot({
      rootDir,
      path: "downloads/report.txt",
      staging: "sibling",
      write: async (candidate) => {
        stagedPath = candidate;
        expect(path.dirname(candidate)).toBe(await fs.realpath(targetDir));
        expect(path.basename(candidate)).toMatch(/^\.fs-safe-output-.*-report\.txt\.part$/);
        await fs.writeFile(candidate, "new", "utf8");
        await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("old");
        return "written";
      },
    });

    expect(result).toEqual({
      path: path.join(await fs.realpath(rootDir), "downloads", "report.txt"),
      result: "written",
    });
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("new");
    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates missing target parents for sibling staging", async () => {
    const rootDir = await tempRoot("fs-safe-output-sibling-parent-");

    await writeExternalFileWithinRoot({
      rootDir,
      path: "nested/deeper/output.txt",
      staging: "sibling",
      write: async (candidate) => {
        await fs.writeFile(candidate, "created", "utf8");
      },
    });

    await expect(fs.readFile(path.join(rootDir, "nested/deeper/output.txt"), "utf8"))
      .resolves.toBe("created");
  });

  it("enforces sibling byte limits before replacing the destination", async () => {
    const rootDir = await tempRoot("fs-safe-output-sibling-limit-");
    const targetPath = path.join(rootDir, "output.bin");
    await fs.writeFile(targetPath, "old", "utf8");

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: "output.bin",
        staging: "sibling",
        maxBytes: 3,
        write: async (candidate) => {
          await fs.writeFile(candidate, "too large", "utf8");
        },
      }), "too-large");

    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("old");
    expect((await fs.readdir(rootDir)).filter((name) => name.startsWith(".fs-safe-output-")))
      .toEqual([]);
  });

  it("cleans a sibling partial when the external writer fails", async () => {
    const rootDir = await tempRoot("fs-safe-output-sibling-fail-");
    let stagedPath = "";

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "output.bin",
        staging: "sibling",
        write: async (candidate) => {
          stagedPath = candidate;
          await fs.writeFile(candidate, "partial", "utf8");
          throw new Error("producer failed");
        },
      }),
    ).rejects.toThrow("producer failed");

    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(rootDir, "output.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["workspace", "sibling"] as const)(
    "uses one portable sanitized name for %s staging and the final target",
    async (staging) => {
      const rootDir = await tempRoot("fs-safe-output-fallback-name-");
      const controlName = "\u0001";
      let stagedName = "";

      const result = await writeExternalFileWithinRoot({
        rootDir,
        path: controlName,
        fallbackFileName: 'safe<>:"|?*\u0085-output.bin',
        staging,
        write: async (candidate) => {
          stagedName = path.basename(candidate);
          await fs.writeFile(candidate, "safe", "utf8");
        },
      });

      expect(stagedName).not.toMatch(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u);
      expect(stagedName).toContain("safe-output.bin");
      expect(result.path).toBe(path.join(await fs.realpath(rootDir), "safe-output.bin"));
      await expect(fs.readFile(result.path, "utf8")).resolves.toBe("safe");
      await expect(fs.stat(path.join(rootDir, controlName))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("preserves caller-provided destination filename spacing", async () => {
    const rootDir = await tempRoot("fs-safe-output-spaces-");
    const fileName = " report .txt ";

    const result = await writeExternalFileWithinRoot({
      rootDir,
      path: fileName,
      write: async (candidate) => {
        await fs.writeFile(candidate, "spaced", "utf8");
      },
    });

    const finalPath = path.join(rootDir, fileName);
    expect(result.path).toBe(path.join(await fs.realpath(rootDir), fileName));
    await expect(fs.readFile(finalPath, "utf8")).resolves.toBe("spaced");
    await expect(fs.stat(path.join(rootDir, fileName.trim()))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts absolute target paths that resolve inside the root", async () => {
    const rootDir = await tempRoot("fs-safe-output-absolute-");
    const targetPath = path.join(rootDir, "nested", "report.txt");

    const result = await writeExternalFileWithinRoot({
      rootDir,
      path: targetPath,
      write: async (candidate) => {
        await fs.writeFile(candidate, "absolute", "utf8");
      },
    });

    expect(result.path).toBe(path.join(await fs.realpath(rootDir), "nested", "report.txt"));
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("absolute");
  });

  it("enforces byte limits while leaving the final target absent", async () => {
    const rootDir = await tempRoot("fs-safe-output-max-bytes-");
    const targetPath = path.join(rootDir, "too-large.bin");

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: "too-large.bin",
        maxBytes: 3,
        write: async (candidate) => {
          await fs.writeFile(candidate, "larger", "utf8");
        },
      }), "too-large");

    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itPosix("applies the requested final file mode", async () => {
    const rootDir = await tempRoot("fs-safe-output-mode-");
    const targetPath = path.join(rootDir, "private.txt");

    await writeExternalFileWithinRoot({
      rootDir,
      path: "private.txt",
      mode: 0o600,
      write: async (candidate) => {
        await fs.writeFile(candidate, "private", { encoding: "utf8", mode: 0o644 });
      },
    });

    const stat = await fs.stat(targetPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rejects empty target paths before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-default-");
    let called = false;

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: "",
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "named", "utf8");
        },
      }), "invalid-path");

    expect(called).toBe(false);
  });

  it("rejects targets outside the root before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-reject-root-");
    const outsideDir = await tempRoot("fs-safe-output-reject-outside-");
    const outsidePath = path.join(outsideDir, "pwned.txt");
    let called = false;

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: outsidePath,
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "pwned", "utf8");
        },
      }), "outside-workspace");

    expect(called).toBe(false);
    await expect(fs.stat(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal targets before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-traversal-root-");
    let called = false;

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: "../../../pwned.txt",
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "pwned", "utf8");
        },
      }), "outside-workspace");

    expect(called).toBe(false);
  });

  it("rejects root directory targets before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-root-target-");
    let called = false;

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: rootDir,
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "not a file target", "utf8");
        },
      }), "invalid-path");

    expect(called).toBe(false);
  });

  it("rejects trailing-separator targets before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-dir-target-");
    let called = false;

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: "nested/",
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "not a file target", "utf8");
        },
      }), "invalid-path");

    expect(called).toBe(false);
  });

  it("rejects absolute in-root trailing-separator targets before normalization", async () => {
    const rootDir = await tempRoot("fs-safe-output-absolute-dir-target-");
    let called = false;

    await expectFsSafeError(writeExternalFileWithinRoot({
        rootDir,
        path: path.join(rootDir, "nested") + path.sep,
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "not a file target", "utf8");
        },
      }), "invalid-path");

    expect(called).toBe(false);
  });

  itPosix("does not let symlinked target parents redirect the external temp write", async () => {
    const rootDir = await tempRoot("fs-safe-output-link-root-");
    const outsideDir = await tempRoot("fs-safe-output-link-outside-");
    await fs.symlink(outsideDir, path.join(rootDir, "link"), "dir");
    let tempPath = "";

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "link/out.txt",
        write: async (candidate) => {
          tempPath = candidate;
          await fs.writeFile(candidate, "pwned", "utf8");
        },
      }),
    ).rejects.toBeTruthy();

    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
  });

  itPosix("atomically replaces a symlink destination without following it", async () => {
    const rootDir = await tempRoot("fs-safe-output-sibling-link-root-");
    const outsideDir = await tempRoot("fs-safe-output-sibling-link-outside-");
    const outsidePath = path.join(outsideDir, "outside.txt");
    const targetPath = path.join(rootDir, "output.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink(outsidePath, targetPath);
    let called = false;

    await writeExternalFileWithinRoot({
      rootDir,
      path: "output.txt",
      staging: "sibling",
      write: async (candidate) => {
        called = true;
        await fs.writeFile(candidate, "replacement", "utf8");
      },
    });

    expect(called).toBe(true);
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(false);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("replacement");
  });

  itPosix("rejects hardlinked final targets and preserves the existing file", async () => {
    const rootDir = await tempRoot("fs-safe-output-hardlink-");
    const sourcePath = path.join(rootDir, "source.txt");
    const hardlinkPath = path.join(rootDir, "hardlink.txt");
    await fs.writeFile(sourcePath, "original", "utf8");
    await fs.link(sourcePath, hardlinkPath);

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "hardlink.txt",
        write: async (candidate) => {
          await fs.writeFile(candidate, "replacement", "utf8");
        },
      }),
    ).rejects.toBeTruthy();

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(hardlinkPath, "utf8")).resolves.toBe("original");
  });

  it("cleans private temp files when the external writer fails", async () => {
    const rootDir = await tempRoot("fs-safe-output-fail-root-");
    let tempPath = "";

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "out.txt",
        write: async (candidate) => {
          tempPath = candidate;
          await fs.writeFile(candidate, "partial", "utf8");
          throw new Error("download failed");
        },
      }),
    ).rejects.toThrow("download failed");

    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(rootDir, "out.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
