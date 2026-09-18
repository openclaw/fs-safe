import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { publishFileExclusive, type PublishFileExclusiveFailureDetails } from "../src/publish-file.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture() {
  const dir = await fs.realpath(await tempRoot("fs-safe-publication-retirement-"));
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  await fs.writeFile(source, "admitted original", { mode: 0o600 });
  const publish = () => publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
  return { dir, source, target, publish };
}

function recoveryPath(error: { details: PublishFileExclusiveFailureDetails }): string {
  expect(error.details.sourceRecovery).toMatchObject({ path: expect.any(String) });
  return error.details.sourceRecovery!.path;
}

describe.skipIf(process.platform === "win32")("moving publication source-retirement receipts", () => {
  it("preserves a different inode captured in the final source-name race", async () => {
    const { dir, source, target, publish } = await fixture();
    const retired = path.join(dir, "retired-original");
    const replacement = path.join(dir, "replacement");
    await fs.writeFile(replacement, "replacement sentinel", { mode: 0o640 });
    const before = await fs.lstat(replacement, { bigint: true });
    const rename = fsSync.renameSync;
    let intercepted = false;
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      if (from === source && !intercepted) {
        intercepted = true;
        rename(source, retired);
        rename(replacement, source);
      }
      rename(from, to);
    });
    const error = await publish().catch((value) => value);
    expect(intercepted).toBe(true);
    expect(error).toMatchObject({
      code: "path-mismatch", details: {
        phase: "source-remove", targetCreated: true, sourceConsumed: false,
        cleanup: "preserved", sourceRecovery: { status: "preserved" },
      },
    });
    const captured = recoveryPath(error);
    expect(await fs.readFile(captured, "utf8")).toBe("replacement sentinel");
    expect(await fs.lstat(captured, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode, nlink: 1n });
    expect(await fs.readFile(target, "utf8")).toBe("admitted original");
    expect(await fs.readFile(retired, "utf8")).toBe("admitted original");
  });

  it("retains an indeterminate capture instead of claiming the source was consumed", async () => {
    const { source, target, publish } = await fixture();
    const rename = fsSync.renameSync;
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (from === source) throw Object.assign(new Error("capture reply lost"), { code: "EIO" });
    });
    const error = await publish().catch((value) => value);
    expect(error).toMatchObject({ details: {
      phase: "source-remove", targetCreated: true, cleanup: "preserved", sourceRecovery: { status: "indeterminate" },
    } });
    expect(error.details).not.toHaveProperty("sourceConsumed");
    expect(await fs.readFile(recoveryPath(error), "utf8")).toBe("admitted original");
    expect(await fs.readFile(target, "utf8")).toBe("admitted original");
  });

  it("exposes the retained private source when its unlink is denied", async () => {
    const { source, target, publish } = await fixture();
    vi.spyOn(fsSync, "unlinkSync").mockImplementation((file) => {
      expect(file).not.toBe(source);
      throw Object.assign(new Error("private retirement unlink denied"), { code: "EACCES" });
    });
    const error = await publish().catch((value) => value);
    expect(error).toMatchObject({
      cause: { cause: { code: "EACCES" } },
      details: {
        phase: "source-remove", targetCreated: true,
        cleanup: "preserved", sourceRecovery: { status: "indeterminate" },
      },
    });
    expect(error.details).not.toHaveProperty("sourceConsumed");
    expect(await fs.readFile(recoveryPath(error), "utf8")).toBe("admitted original");
    expect(await fs.readFile(target, "utf8")).toBe("admitted original");
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a recreated source and reports the completed original retirement", async () => {
    const { dir, source, target, publish } = await fixture();
    const rename = fsSync.renameSync;
    vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (from === source) fsSync.writeFileSync(source, "fresh source", { mode: 0o640 });
    });
    const error = await publish().catch((value) => value);
    expect(error).toMatchObject({ code: "path-mismatch", details: {
      phase: "rename-verify", sourceConsumed: true, cleanup: "preserved",
    } });
    expect(error.details).not.toHaveProperty("sourceRecovery");
    expect(await fs.readFile(source, "utf8")).toBe("fresh source");
    expect(await fs.readFile(target, "utf8")).toBe("admitted original");
    expect((await fs.readdir(dir)).sort()).toEqual(["source", "target"]);
  });

  it("records source retirement before a later destination fence fails", async () => {
    const { dir, source, target, publish } = await fixture();
    const retiredTarget = path.join(dir, "published-original");
    const unlink = fsSync.unlinkSync;
    let intercepted = false;
    vi.spyOn(fsSync, "unlinkSync").mockImplementation((file) => {
      unlink(file);
      if (!intercepted) {
        intercepted = true;
        fsSync.renameSync(target, retiredTarget);
        fsSync.writeFileSync(target, "replacement target", { mode: 0o640 });
      }
    });
    const error = await publish().catch((value) => value);
    expect(intercepted).toBe(true);
    expect(error).toMatchObject({ code: "path-mismatch", details: {
      phase: "source-remove", sourceConsumed: true, cleanup: "preserved",
    } });
    expect(await fs.readFile(target, "utf8")).toBe("replacement target");
    expect(await fs.readFile(retiredTarget, "utf8")).toBe("admitted original");
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
