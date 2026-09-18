import { spawnSync } from "node:child_process";
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/index.js";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import * as command from "../src/sibling-rename-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: vi.fn(original.spawnSync) };
});
const { tempRoot } = useRealTempDirs();
beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  vi.clearAllMocks();
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

type Operation = "copyIn" | "create stream" | "write stream";
async function fixture(operation: Operation, collision = false) {
  const directory = await tempRoot("fs-safe-root-copy-stage-");
  const destination = path.join(directory, "destination");
  await fs.mkdir(destination, { mode: 0o700 });
  const source = path.join(directory, "source");
  const content = "all original bytes before publication";
  await fs.writeFile(source, content, { mode: 0o600 });
  const target = path.join(destination, "final");
  const scoped = await root(destination);
  const onDestinationPublished = vi.fn();
  const stream = async function* () {
    if (!collision) expect(fsSync.existsSync(target)).toBe(false);
    yield Buffer.from("all original bytes ");
    await Promise.resolve();
    if (!collision) expect(fsSync.existsSync(target)).toBe(false);
    yield Buffer.from("before publication");
  };
  const publish = () => operation === "copyIn"
    ? scoped.copyIn("final", source, { overwrite: false, mode: 0o600, onDestinationPublished })
    : operation === "create stream" ? scoped.create("final", stream(), { mode: 0o600 })
      : scoped.write("final", stream(), { overwrite: false, mode: 0o600 });
  let stage: { path: string; identity: BigIntStats } | undefined;
  let sentinel: BigIntStats | undefined;
  const link = vi.spyOn(fsSync, "linkSync").mockImplementation((from, to) => {
    expect(to).toBe(target);
    stage = { path: String(from), identity: fsSync.lstatSync(from, { bigint: true }) };
    expect(fsSync.readFileSync(from, "utf8")).toBe(content);
    if (collision) {
      fsSync.writeFileSync(target, "collision sentinel", { flag: "wx", mode: 0o600 });
      sentinel = fsSync.lstatSync(target, { bigint: true });
    }
    throw Object.assign(new Error("filesystem cannot link"), { code: "ENOTSUP" });
  });
  return { directory, destination, source, target, content, publish, link, onDestinationPublished,
    stage: () => stage!, sentinel: () => sentinel };
}

describe("Root exclusive publication without filesystem hardlinks", () => {
  it.each((["copyIn", "create stream", "write stream"] as const).flatMap(operation =>
    [false, true].map(collision => ({ operation, collision }))))(
    "runs the system bridge for $operation (collision=$collision)", async ({ operation, collision }) => {
      const fixture_ = await fixture(operation, collision);
      const copySync = vi.spyOn(fsSync, "copyFileSync");
      const copy = vi.spyOn(fs, "copyFile");
      const replace = vi.spyOn(fsSync, "renameSync");
      const rename = vi.spyOn(command, "renameSiblingNoReplaceSync");
      if (collision) await expect(fixture_.publish()).rejects.toMatchObject({ code: "already-exists" });
      else await expect(fixture_.publish()).resolves.toBeUndefined();
      const before = fixture_.sentinel();
      expect(fixture_.link).toHaveBeenCalledOnce();
      expect(rename).toHaveBeenCalledOnce();
      expect(spawnSync).toHaveBeenCalled();
      const dispatch = rename.mock.calls[0]![0];
      expect(dispatch.source.identity).toMatchObject({ dev: fixture_.stage().identity.dev, ino: fixture_.stage().identity.ino });
      expect(copySync).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      const final = await fs.lstat(fixture_.target, { bigint: true });
      expect(final).toMatchObject({ dev: (before ?? fixture_.stage().identity).dev, ino: (before ?? fixture_.stage().identity).ino, nlink: 1n });
      if (process.platform !== "win32") expect(final.mode & 0o7777n).toBe(0o600n);
      expect(await fs.readFile(fixture_.target, "utf8")).toBe(collision ? "collision sentinel" : fixture_.content);
      expect(await fs.readFile(fixture_.source, "utf8")).toBe(fixture_.content);
      expect(await fs.readdir(fixture_.destination)).toEqual(["final"]);
      expect(fixture_.onDestinationPublished).toHaveBeenCalledTimes(operation === "copyIn" && !collision ? 1 : 0);
    }, 30_000,
  );

  it.each((["copyIn", "create stream", "write stream"] as const).flatMap(operation =>
    [false, true].map(renamed => ({ operation, renamed }))))(
    "preserves uncertain $operation publication without a success receipt (renamed=$renamed)", async ({ operation, renamed }) => {
      const fixture_ = await fixture(operation);
      const execute = command.renameSiblingNoReplaceSync;
      const rename = vi.spyOn(command, "renameSiblingNoReplaceSync").mockImplementation(input => {
        if (renamed) execute(input);
        throw new FsSafeError("helper-failed", "command reply lost", { details: { commit: "unknown" } });
      });
      await expect(fixture_.publish()).rejects.toMatchObject({ code: "helper-failed", details: { commit: "unknown" } });
      expect(rename).toHaveBeenCalledOnce();
      expect(fixture_.onDestinationPublished).not.toHaveBeenCalled();
      const retained = renamed ? fixture_.target : fixture_.stage().path;
      expect(await fs.readFile(retained, "utf8")).toBe(fixture_.content);
      expect(await fs.lstat(retained, { bigint: true })).toMatchObject({
        dev: fixture_.stage().identity.dev, ino: fixture_.stage().identity.ino, nlink: 1n,
      });
      expect(await fs.readdir(fixture_.destination)).toEqual([path.basename(retained)]);
      expect(await fs.readFile(fixture_.source, "utf8")).toBe(fixture_.content);
    }, 30_000,
  );

  it("retains a completed copy and the original observer rejection", async () => {
    const fixture_ = await fixture("copyIn");
    const failure = new Error("observer rejected complete copy");
    fixture_.onDestinationPublished.mockImplementation(receipt => {
      expect(fsSync.existsSync(fixture_.stage().path)).toBe(false);
      expect(fsSync.readFileSync(receipt.path, "utf8")).toBe(fixture_.content);
      expect(receipt).toMatchObject({ dev: fixture_.stage().identity.dev, ino: fixture_.stage().identity.ino });
      throw failure;
    });
    await expect(fixture_.publish()).rejects.toBe(failure);
    expect(fixture_.onDestinationPublished).toHaveBeenCalledOnce();
    expect(await fs.readFile(fixture_.target, "utf8")).toBe(fixture_.content);
    expect(await fs.readdir(fixture_.destination)).toEqual(["final"]);
  }, 30_000);

  it.skipIf(process.platform === "win32")("records a completed copy before closing the command parent", async () => {
    const fixture_ = await fixture("copyIn");
    const failure = new Error("parent close failed after publication");
    const open = command.openSiblingRenameParentSync;
    let parentFd: number | undefined;
    vi.spyOn(command, "openSiblingRenameParentSync").mockImplementation((...args) => {
      parentFd = open(...args);
      return parentFd;
    });
    const close = fsSync.closeSync;
    vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
      close(fd);
      if (fd === parentFd) {
        expect(fixture_.onDestinationPublished).toHaveBeenCalledOnce();
        throw failure;
      }
    });
    await expect(fixture_.publish()).rejects.toMatchObject({ cause: failure });
    expect(fixture_.onDestinationPublished).toHaveBeenCalledOnce();
    expect(await fs.readFile(fixture_.target, "utf8")).toBe(fixture_.content);
    expect(await fs.readdir(fixture_.destination)).toEqual(["final"]);
  }, 30_000);

  it.each(["copyIn", "create stream", "write stream"] as const)(
    "cleans an unpublished %s stage when the command runtime is unavailable", async operation => {
      const fixture_ = await fixture(operation);
      vi.spyOn(command, "renameSiblingNoReplaceSync").mockImplementation(() => {
        throw new FsSafeError("helper-unavailable", "runtime missing", { details: { commit: "not-attempted" } });
      });
      await expect(fixture_.publish()).rejects.toMatchObject({ code: "helper-unavailable", details: { commit: "not-attempted" } });
      expect(fixture_.onDestinationPublished).not.toHaveBeenCalled();
      expect(await fs.readdir(fixture_.destination)).toEqual([]);
      expect(await fs.readFile(fixture_.source, "utf8")).toBe(fixture_.content);
    },
  );
});
