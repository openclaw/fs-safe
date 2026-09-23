import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { replaceDirectoryAtomic } from "../src/atomic.js";
import { FsSafeError } from "../src/errors.js";
import { backupPaths, fixture } from "./helpers/replace-directory-authority.js";

type Failure = Error & { code?: string; details?: unknown };
type FailureKind = "errno" | "classified" | "numeric-code" | "null" | "undefined";

function primaryFailure(kind: FailureKind) {
  const code = kind === "classified" ? "path-mismatch" : kind === "numeric-code" ? 42 : "EACCES";
  const readCode = vi.fn(() => code);
  const value = kind === "null" ? null : kind === "undefined" ? undefined
    : kind === "classified" ? new FsSafeError("path-mismatch", "original policy failure")
    : new Error("original operational failure");
  if (value) Object.defineProperty(value, "code", { configurable: true, get: readCode });
  return { value, readCode, code: value && typeof code === "string" ? code : undefined };
}

async function captureFailure(operation: Promise<void>): Promise<Failure> {
  try { await operation; } catch (error) { return error as Failure; }
  throw new Error("expected directory replacement to fail");
}

function expectFailureProperties(failure: Failure, kind: FailureKind, code: string | undefined) {
  const classified = kind === "classified";
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof FsSafeError).toBe(classified);
  if (classified) expect(failure).toMatchObject({ category: "policy" });
  expect(Object.getOwnPropertyDescriptor(failure, "code")).toEqual(code === undefined ? undefined : {
    value: code, configurable: true, enumerable: classified, writable: classified,
  });
  expect(Object.getOwnPropertyDescriptor(failure, "details")).toEqual({
    value: failure.details, configurable: true, enumerable: classified, writable: classified,
  });
  expect(Object.getOwnPropertyDescriptor(failure, "cause")).toEqual({
    value: failure.cause, configurable: true, enumerable: false, writable: true,
  });
}

it.each(
  (["errno", "classified", "numeric-code", "null", "undefined"] as const).flatMap(kind =>
    [false, true].map(closeFails => ({ kind, closeFails }))),
)("preserves $kind cleanup errors and property descriptors (closeFails=$closeFails)", async ({ kind, closeFails }) => {
  const setup = await fixture();
  const primary = primaryFailure(kind);
  setup.removeOwnedTree.mockRejectedValue(primary.value);
  const closeFailure = new Error("retained parent close failed");
  const closeSync = fsSync.closeSync.bind(fsSync);
  let injected = false;
  vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
    closeSync(fd);
    if (closeFails && !injected && setup.parentFds.has(fd)) {
      injected = true;
      throw closeFailure;
    }
  });

  const failure = await captureFailure(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }));
  expect(injected).toBe(closeFails);
  expectFailureProperties(failure, kind, primary.code);
  expect(failure.details).toMatchObject({
    phase: "cleanup", publication: "published", recovery: "cleanup-incomplete",
  });
  if (closeFails) {
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const members = (failure.cause as AggregateError).errors;
    expect(members).toHaveLength(2);
    expect(members[1]).toBe(closeFailure);
    expectFailureProperties(members[0] as Failure, kind, primary.code);
    expect(members[0].cause).toBe(primary.value);
    expect(members[0].details).toEqual(failure.details);
  } else {
    expect(failure.cause).toBe(primary.value);
  }
  expect(primary.readCode).toHaveBeenCalledTimes(primary.value ? 1 : 0);
  expect(setup.renameNoReplace).toHaveBeenCalledTimes(2);
  expect(setup.removeOwnedTree).toHaveBeenCalledOnce();
  await expect(fs.readFile(path.join(setup.target, "value.txt"), "utf8")).resolves.toBe("new");
  const backups = await backupPaths(setup.targetParent);
  expect(backups).toHaveLength(1);
  await expect(fs.readFile(path.join(backups[0]!, "value.txt"), "utf8")).resolves.toBe("old");
});

it.each(["errno", "classified"] as const)("keeps the original %s failure first when rollback also fails", async kind => {
  const setup = await fixture();
  const primary = primaryFailure(kind);
  const rollbackFailure = Object.assign(new Error("rollback denied"), { code: "EIO" });
  let rejectStageObservation = false;
  setup.hooks.afterRename = ({ sourceName }) => {
    if (sourceName === "target") rejectStageObservation = true;
  };
  setup.hooks.beforeRename = ({ call }) => {
    if (call === 2) throw rollbackFailure;
  };
  const lstatSync = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((pathname, options) => {
    if (rejectStageObservation && pathname === setup.staged) {
      rejectStageObservation = false;
      throw primary.value;
    }
    return lstatSync(pathname, options);
  });

  const failure = await captureFailure(replaceDirectoryAtomic({ stagedDir: setup.staged, targetDir: setup.target }));
  expectFailureProperties(failure, kind, primary.code);
  expect(failure.cause).toBeInstanceOf(AggregateError);
  const members = (failure.cause as AggregateError).errors;
  expect(members).toHaveLength(2);
  expect(members[0]).toBe(primary.value);
  expect(members[1]).toBe(rollbackFailure);
  expect(primary.readCode).toHaveBeenCalledOnce();
  expect(failure.details).toMatchObject({
    phase: "rollback", publication: "not-published", recovery: "indeterminate",
  });
  expect(setup.renameNoReplace).toHaveBeenCalledTimes(2);
  expect(setup.removeOwnedTree).not.toHaveBeenCalled();
  await expect(fs.lstat(setup.target)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(path.join(setup.staged, "value.txt"), "utf8")).resolves.toBe("new");
  const backups = await backupPaths(setup.targetParent);
  expect(backups).toHaveLength(1);
  await expect(fs.readFile(path.join(backups[0]!, "value.txt"), "utf8")).resolves.toBe("old");
});
