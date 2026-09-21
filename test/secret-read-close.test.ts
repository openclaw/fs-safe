import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { readSecretFileSync, tryReadSecretFileSync } from "../src/secret.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

function captureThrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected secret read to throw");
}

function failClose(failure: unknown) {
  const close = fsSync.closeSync.bind(fsSync);
  return vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    close(fd);
    throw failure;
  });
}

function expectClosedOnce(close: ReturnType<typeof failClose>): void {
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => fsSync.fstatSync(close.mock.calls[0]![0])).toThrow(
    expect.objectContaining({ code: "EBADF" }),
  );
}

describe.each([
  { name: "strict", read: readSecretFileSync },
  { name: "optional", read: tryReadSecretFileSync },
])("$name secret reader close failures", ({ read }) => {
  it("preserves the read error and cause when closing also fails", async () => {
    const filePath = path.join(await tempRoot("fs-safe-secret-read-close-"), "token");
    await fs.writeFile(filePath, "secret");
    const readFailure = Object.assign(new Error("read failed"), { code: "EIO" });
    const closeFailure = Object.assign(new Error("close failed"), { code: "EBADF" });
    const bytes = vi.spyOn(fsSync, "readSync").mockImplementation(() => { throw readFailure; });
    const close = failClose(closeFailure);

    const error = captureThrown(() => read(filePath, "token"));

    expect(error).toBeInstanceOf(FsSafeError);
    expect(error).toMatchObject({ code: "read-failed", category: "operational", cause: readFailure });
    expect(bytes).toHaveBeenCalledTimes(1);
    expectClosedOnce(close);
  });

  it("preserves a post-pin identity mismatch when closing also fails", async () => {
    const root = await tempRoot("fs-safe-secret-identity-close-");
    const filePath = path.join(root, "token");
    const replacementPath = path.join(root, "replacement");
    await fs.writeFile(filePath, "original");
    await fs.writeFile(replacementPath, "replacement");
    const stat = fsSync.statSync.bind(fsSync);
    let inputInspections = 0;
    vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
      if (args[0] === filePath && ++inputInspections === 2) {
        fsSync.renameSync(filePath, path.join(root, "original"));
        fsSync.renameSync(replacementPath, filePath);
      }
      return stat(...args);
    });
    const bytes = vi.spyOn(fsSync, "readSync");
    const close = failClose(Object.assign(new Error("close failed"), { code: "EBADF" }));

    const error = captureThrown(() => read(filePath, "token"));

    expect(error).toBeInstanceOf(FsSafeError);
    expect(error).toMatchObject({
      code: "path-mismatch",
      category: "policy",
      cause: expect.objectContaining({ code: "path-mismatch" }),
    });
    expect(inputInspections).toBe(2);
    expect(bytes).not.toHaveBeenCalled();
    expectClosedOnce(close);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
  });

  it.each([
    { content: "secret", failure: new Error("close failed") },
    { content: " \n", failure: new Error("close failed") },
    { content: "secret", failure: undefined },
    { content: " \n", failure: undefined },
  ])("reports a lone close failure before trimming $content", async ({ content, failure }) => {
    const filePath = path.join(await tempRoot("fs-safe-secret-success-close-"), "token");
    await fs.writeFile(filePath, content);
    const close = failClose(failure);

    expect(captureThrown(() => read(filePath, "token"))).toBe(failure);
    expectClosedOnce(close);
  });
});
