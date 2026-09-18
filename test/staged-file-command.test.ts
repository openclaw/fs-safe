import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageFileInDirectory } from "../src/advanced.js";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import * as linux from "../src/linux-rename-command.js";
import * as windows from "../src/windows-move-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

function unsupportedLink() {
  return Object.assign(new Error("hardlinks unavailable"), { code: "ENOTSUP" });
}

describe("staged publication command outcomes", () => {
  it.skipIf(process.platform === "win32")("selects the publication method separately for a collision and later retry", async () => {
    const directory = await tempRoot("fs-safe-stage-command-retry-");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await fs.writeFile(path.join(directory, "final"), "sentinel");
    const command = vi.spyOn(linux, "renameLinuxNoReplaceSync").mockImplementation(() => {
      throw new FsSafeError("already-exists", "collision", { details: { commit: "not-attempted" } });
    });
    vi.spyOn(fsSync, "linkSync").mockImplementationOnce(() => { throw unsupportedLink(); });
    await using staged = await stageFileInDirectory({ directory, content: "owned" });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      code: "already-exists", details: { publication: { status: "not-published" } },
    });
    await staged.assertCurrent();
    expect(await staged.publish("other", { overwrite: false })).toMatchObject({ method: "link-unlink" });
    expect(command).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("sentinel");
    expect(await fs.readFile(path.join(directory, "other"), "utf8")).toBe("owned");
    expect((await fs.readdir(directory)).sort()).toEqual(["final", "other"]);
  });

  it.skipIf(process.platform === "win32")("passes the original parent and source pins to the Linux command", async () => {
    const directory = await tempRoot("fs-safe-stage-command-pins-");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw unsupportedLink(); });
    const command = vi.spyOn(linux, "renameLinuxNoReplaceSync").mockImplementation((input) => {
      const source = fsSync.fstatSync(input.source.fd!, { bigint: true });
      const parent = fsSync.fstatSync(input.source.parentFd, { bigint: true });
      expect(input.target.parentFd).toBe(input.source.parentFd);
      expect(input.source.identity).toMatchObject({ dev: source.dev, ino: source.ino });
      expect(input.source.parentIdentity).toEqual({ dev: parent.dev, ino: parent.ino });
      expect(input.source.links).toBe(1n);
      fsSync.renameSync(path.join(directory, input.source.basename), path.join(directory, input.target.basename));
    });
    await using staged = await stageFileInDirectory({ directory, content: "owned" });
    expect(await staged.publish("final", { overwrite: false })).toMatchObject({ method: "rename" });
    expect(command).toHaveBeenCalledOnce();
    expect(await fs.lstat(path.join(directory, "final"), { bigint: true })).toMatchObject({
      dev: staged.receipt.identity.dev, ino: staged.receipt.identity.ino, nlink: 1n,
    });
    expect(await staged.cleanup()).toMatchObject({ status: "not-needed" });
  });

  it.skipIf(process.platform === "win32")("keeps the stage retryable when the command runtime is unavailable before dispatch", async () => {
    const directory = await tempRoot("fs-safe-stage-command-unavailable-");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw unsupportedLink(); });
    vi.spyOn(linux, "renameLinuxNoReplaceSync").mockImplementation(() => {
      throw new FsSafeError("helper-unavailable", "runtime unavailable", { details: { commit: "not-attempted" } });
    });
    await using staged = await stageFileInDirectory({ directory, content: "owned" });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      code: "helper-unavailable", details: { publication: { status: "not-published" } },
    });
    await staged.assertCurrent();
    expect(await staged.cleanup()).toMatchObject({ status: "removed" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("preserves an unknown command outcome even when the final file already exists", async () => {
    const directory = await tempRoot("fs-safe-stage-command-unknown-");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw unsupportedLink(); });
    vi.spyOn(linux, "renameLinuxNoReplaceSync").mockImplementation((input) => {
      fsSync.renameSync(path.join(directory, input.source.basename), path.join(directory, input.target.basename));
      throw new FsSafeError("helper-failed", "reply unavailable", { details: { commit: "unknown" } });
    });
    const staged = await stageFileInDirectory({ directory, content: "owned" });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      details: { publication: { status: "indeterminate" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "preserved", resources: "closed" });
    await expect(staged[Symbol.asyncDispose]()).rejects.toMatchObject({ code: "not-removable" });
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("owned");
  });

  it("records a Windows command's committed rename before its verification error", async () => {
    const directory = await tempRoot("fs-safe-stage-command-committed-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw unsupportedLink(); });
    vi.spyOn(windows, "moveWindowsFileNoReplaceSync").mockImplementation((input) => {
      fsSync.renameSync(path.join(directory, input.source.basename), path.join(directory, input.target.basename));
      throw new FsSafeError("helper-failed", "post-rename verification failed", { details: { commit: "committed" } });
    });
    await using staged = await stageFileInDirectory({ directory, content: "owned", mode: 0o644 });
    await expect(staged.publish("final", { overwrite: false })).rejects.toMatchObject({
      details: { publication: { status: "published", method: "rename" } },
    });
    expect(await staged.cleanup()).toMatchObject({ status: "not-needed", resources: "closed" });
    expect(await fs.readFile(path.join(directory, "final"), "utf8")).toBe("owned");
  });
});
