import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeSiblingTempFile, writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
});

it.each(["known", "transient-unknown", "unknown", "rounded-replacement"] as const)(
  "uses exact fail-closed Windows identity checks (%s)", async (state) => {
    const dir = await tempRoot("fs-safe-sibling-windows-");
    const final = path.join(dir, "final");
    await fs.writeFile(final, "old");
    let temporary = "";
    let opened = false;
    let inspections = 0;
    const open = fs.open.bind(fs);
    const lstat = fs.lstat.bind(fs);
    const originalIno = 2n ** 53n;
    const replacementIno = originalIno + 1n;
    expect(Number(originalIno)).toBe(Number(replacementIno));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      const stat = await lstat(candidate, options);
      if ((candidate === temporary || candidate === final) && options?.bigint) {
        inspections++;
        const unknown = state === "unknown" || (state === "transient-unknown" && inspections === 1);
        return Object.assign(stat, {
          dev: unknown ? 0n : 1n,
          ino: unknown ? 0n : state === "rounded-replacement" && opened ? replacementIno : originalIno,
        });
      }
      return stat;
    });
    const chmod = vi.spyOn(fs, "chmod");
    vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (candidate === dir) throw Object.assign(new Error("directory open unsupported"), { code: "EISDIR" });
      const handle = await open(candidate, flags, mode);
      if (candidate === temporary) {
        expect(flags).toBe(fsSync.constants.O_RDWR);
        opened = true;
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          return Object.assign(await stat(options), { dev: 1n, ino: originalIno });
        });
        if (state === "rounded-replacement") {
          await fs.rename(temporary, path.join(dir, "moved"));
          await fs.writeFile(temporary, "replacement");
        }
      }
      return handle;
    });
    const operation = writeSiblingTempFile({
      dir,
      writeTemp: async (candidate) => {
        temporary = candidate;
        await fs.writeFile(candidate, "new");
      },
      resolveFinalPath: () => final,
    });
    if (state === "known" || state === "transient-unknown") {
      await operation;
      expect(await fs.readFile(final, "utf8")).toBe("new");
    } else {
      await expect(operation).rejects.toMatchObject({ code: "path-mismatch" });
      expect(await fs.readFile(final, "utf8")).toBe("old");
      expect(await fs.readFile(temporary, "utf8")).toBe(state === "unknown" ? "new" : "replacement");
      if (state === "unknown") {
        expect(inspections).toBe(2);
        expect(opened).toBe(false);
      }
    }
    expect(chmod).not.toHaveBeenCalled();
  },
);

it("preserves the original and replacement parent when the callback replaces the directory", async () => {
  const dir = await tempRoot("fs-safe-sibling-parent-");
  const parent = path.join(dir, "parent");
  const moved = path.join(dir, "moved");
  await fs.mkdir(parent);
  let name = "";
  await expect(writeSiblingTempFile({
    dir: parent,
    writeTemp: async (temporary) => {
      name = path.basename(temporary);
      await fs.writeFile(temporary, "producer");
      await fs.rename(parent, moved);
      await fs.mkdir(parent);
      await fs.writeFile(path.join(parent, name), "replacement");
    },
    resolveFinalPath: () => path.join(parent, "final"),
  })).rejects.toMatchObject({ code: "path-mismatch" });
  __cleanupRegisteredTempPathsForTest();
  expect(await fs.readFile(path.join(parent, name), "utf8")).toBe("replacement");
  expect(await fs.readFile(path.join(moved, name), "utf8")).toBe("producer");
});

it("cleans only the original private workspace identity in writeViaSiblingTempPath", async () => {
  const rootDir = await tempRoot("fs-safe-sibling-workspace-");
  let workspace = "";
  let moved = "";
  try {
    await expect(writeViaSiblingTempPath({
      rootDir,
      targetPath: path.join(rootDir, "final"),
      writeTemp: async (temporary) => {
        workspace = path.dirname(temporary);
        moved = `${workspace}-moved`;
        await fs.writeFile(temporary, "producer");
        await fs.rename(workspace, moved);
        await fs.mkdir(workspace);
        await fs.writeFile(path.join(workspace, "sentinel"), "keep");
        throw new Error("producer failed");
      },
    })).rejects.toThrow("producer failed");
    __cleanupRegisteredTempPathsForTest();
    expect(await fs.readFile(path.join(workspace, "sentinel"), "utf8")).toBe("keep");
    await expect(fs.lstat(path.join(rootDir, "final"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    if (moved) await fs.rm(moved, { recursive: true, force: true });
  }
});
