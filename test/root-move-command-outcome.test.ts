import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { FsSafeError } from "../src/errors.js";
import { resolveRootContext } from "../src/root-context.js";
import { movePathNoReplaceWithCommand, type RootMoveCommandInput } from "../src/root-move-command.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => vi.spyOn(process, "emitWarning").mockImplementation(() => undefined));
afterEach(() => { vi.restoreAllMocks(); __setFsSafeTestHooksForTest(); });

async function fixture() {
  const directory = await tempRoot("fs-safe-command-outcome-");
  const source = path.join(directory, "source"), target = path.join(directory, "target");
  await fs.writeFile(source, "original A");
  const context = await resolveRootContext(directory);
  const parent = await createAsyncDirectoryGuard(directory, { bigint: true });
  const execute = (command: (input: RootMoveCommandInput) => void, assertion?: () => void, hookRan = true) =>
    movePathNoReplaceWithCommand({
      root: context, options: { assertBeforeMutation: assertion },
      paths: { sourcePath: source, sourceParentPath: directory, targetPath: target, targetParentPath: directory },
      sourceParent: parent, targetParent: parent, mutationHookRan: hookRan, command, feature: "test atomic move",
    });
  return { source, target, execute, rename: () => fsSync.renameSync(source, target) };
}

it.each(["first-target", "final-target", "parent-fstat"] as const)("retains a successful command receipt after %s verification fails", async phase => {
  const f = await fixture();
  const failure = Object.assign(new Error("post-command observation failed"), { code: "EIO" });
  const lstat = fsSync.lstatSync.bind(fsSync), fstat = fsSync.fstatSync.bind(fsSync);
  let committed = false, targetChecks = 0;
  const command = vi.fn(() => { f.rename(); committed = true; });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((file, options) => {
    if (committed && String(file) === f.target && ++targetChecks === (phase === "first-target" ? 1 : phase === "final-target" ? 2 : -1)) throw failure;
    return lstat(file, options);
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
    if (committed && phase === "parent-fstat") throw failure;
    return fstat(fd, options);
  });
  await expect(f.execute(command)).rejects.toMatchObject({ cause: failure, details: { commit: "committed", sourceConsumed: true } });
  expect(command).toHaveBeenCalledOnce();
  await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(f.target, "utf8")).toBe("original A");
});

it.each([false, true])("keeps committed state through parent close failure (verification also fails=%s)", async verificationFails => {
  const f = await fixture();
  const observation = new Error("verification failed"), closing = new Error("parent close failed");
  const lstat = fsSync.lstatSync.bind(fsSync), close = fsSync.closeSync.bind(fsSync);
  let committed = false;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((file, options) => {
    if (committed && verificationFails && String(file) === f.target) throw observation;
    return lstat(file, options);
  });
  const closes = vi.spyOn(fsSync, "closeSync").mockImplementation(fd => { close(fd); throw closing; });
  const error = await f.execute(() => { f.rename(); committed = true; }).catch(error => error);
  if (verificationFails) {
    expect(error).toMatchObject({ name: "SuppressedError",
      error: { cause: closing, details: { commit: "committed", sourceConsumed: true } },
      suppressed: { cause: observation, details: { commit: "committed", sourceConsumed: true } },
    });
  } else expect(error).toMatchObject({ cause: closing, details: { commit: "committed", sourceConsumed: true } });
  expect(closes).toHaveBeenCalledOnce();
  expect(await fs.readFile(f.target, "utf8")).toBe("original A");
});

it("honors a Windows adapter's confirmed committed error", async () => {
  const f = await fixture();
  const failure = new FsSafeError("helper-failed", "command handle close failed", { details: { phase: "close", commit: "committed" } });
  await expect(f.execute(() => { f.rename(); throw failure; })).rejects.toMatchObject({
    cause: failure, details: { phase: "close", commit: "committed", sourceConsumed: true },
  });
  await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(f.target, "utf8")).toBe("original A");
});

it.each(["authority", "hook"] as const)("does not trust a pre-dispatch %s error's claimed commit", async phase => {
  const f = await fixture();
  const failure = new FsSafeError("helper-failed", "pre-dispatch rejection", { details: { commit: "committed" } });
  const command = vi.fn(f.rename);
  if (phase === "hook") __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async () => { throw failure; } });
  await expect(f.execute(command, phase === "authority" ? () => { throw failure; } : undefined, phase !== "hook")).rejects.toBe(failure);
  expect(failure.details).not.toHaveProperty("sourceConsumed");
  expect(command).not.toHaveBeenCalled();
  expect(await fs.readFile(f.source, "utf8")).toBe("original A");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])("preserves an unknown command reply without adding a commit (renamed=%s)", async renamed => {
  const f = await fixture();
  const failure = new FsSafeError("helper-failed", "reply lost", { details: { commit: "unknown" } });
  const command = vi.fn(() => { if (renamed) f.rename(); throw failure; });
  await expect(f.execute(command)).rejects.toBe(failure);
  expect(failure.details).not.toHaveProperty("sourceConsumed");
  expect(command).toHaveBeenCalledOnce();
  expect(await fs.readFile(renamed ? f.target : f.source, "utf8")).toBe("original A");
});

it("preserves a known command admission failure without adding a commit", async () => {
  const f = await fixture();
  const failure = new FsSafeError("helper-unavailable", "command unavailable", { details: { commit: "not-attempted" } });
  await expect(f.execute(() => { throw failure; })).rejects.toBe(failure);
  expect(failure.details).not.toHaveProperty("sourceConsumed");
  expect(await fs.readFile(f.source, "utf8")).toBe("original A");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});
