import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { __cleanupRegisteredTempPathForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture(kind: "file" | "directory" = "file") {
  const dir = await tempRoot("fs-safe-move-stage-owner-");
  const source = path.join(dir, "source"), target = path.join(dir, "target");
  if (kind === "directory") {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "child"), "source bytes");
  } else await fs.writeFile(source, "source bytes");
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === source && to === target) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    await rename(from, to);
  });
  return { dir, source, target, moved: path.join(dir, "displaced") };
}

it.each(["file", "directory"] as const)("preserves a replaced %s stage after a copy failure", async kind => {
  const { dir, source, target, moved } = await fixture(kind);
  let stage!: string;
  const error = Object.assign(new Error("copy failed"), { code: "EIO" });
  const substitute = async () => {
    await fs.rename(stage, moved);
    if (kind === "directory") {
      await fs.mkdir(stage);
      await fs.writeFile(path.join(stage, "sentinel"), "unowned bytes");
    } else await fs.writeFile(stage, "unowned bytes");
    throw error;
  };
  if (kind === "file") {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])).startsWith(".fs-safe-move-")) {
        stage = String(args[0]);
        vi.spyOn(handle, "write").mockImplementation(substitute);
      }
      return handle;
    });
  } else {
    const mkdir = fs.mkdir.bind(fs), opendir = fs.opendir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      if (path.basename(String(args[0])).startsWith(".fs-safe-move-")) stage = String(args[0]);
      return result;
    });
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      if (args[0] === source) return await substitute();
      return await opendir(...args);
    });
  }
  await expect(movePathWithCopyFallback({ from: source, to: target })).rejects.toBe(error);
  __cleanupRegisteredTempPathForTest(stage);
  expect(await fs.readFile(kind === "file" ? stage : path.join(stage, "sentinel"), "utf8"))
    .toBe("unowned bytes");
  expect(await fs.readFile(kind === "file" ? source : path.join(source, "child"), "utf8"))
    .toBe("source bytes");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.readdir(dir)).includes("displaced")).toBe(true);
});

it("rejects a substituted stage immediately before publication", async () => {
  const { dir, source, target, moved } = await fixture();
  let stage!: string;
  await expect(movePathWithCopyFallback({
    from: source, to: target,
    assertBeforeRename() {
      const name = fsSync.readdirSync(dir).find(entry => entry.startsWith(".fs-safe-move-"));
      if (!name) return;
      stage = path.join(dir, name);
      fsSync.renameSync(stage, moved);
      fsSync.writeFileSync(stage, "unowned bytes");
    },
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(await fs.readFile(source, "utf8")).toBe("source bytes");
  expect(await fs.readFile(stage, "utf8")).toBe("unowned bytes");
  expect(await fs.readFile(moved, "utf8")).toBe("source bytes");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a zero-progress copy without retrying the write", async () => {
  const { dir, source, target } = await fixture();
  const open = fs.open.bind(fs);
  let writes = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (path.basename(String(args[0])).startsWith(".fs-safe-move-")) {
      vi.spyOn(handle, "write").mockImplementation(async () => {
        if (++writes > 1) throw new Error("unexpected repeated write");
        return { bytesWritten: 0, buffer: Buffer.alloc(0) };
      });
    }
    return handle;
  });
  await expect(movePathWithCopyFallback({ from: source, to: target })).rejects.toMatchObject({
    code: "helper-failed", message: "move copy made no progress",
  });
  expect(writes).toBe(1);
  expect(await fs.readdir(dir)).toEqual(["source"]);
});
