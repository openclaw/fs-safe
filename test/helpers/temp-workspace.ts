import fs from "node:fs";
import { expect } from "vitest";
import { FsSafeError } from "../../src/errors.js";
import { getNativeBinding } from "../../src/native.js";
import { tempWorkspace, tempWorkspaceSync } from "../../src/temp.js";

// Shared API tests assert rejection in fallback lanes, and exercise their
// workspace behavior only when the host admits native directory cleanup.
export async function expectTempWorkspaceUnavailable(rootDir: string): Promise<boolean> {
  let available = false;
  try {
    available = typeof getNativeBinding()?.renameNoReplace === "function";
  } catch (error) {
    if (!(error instanceof FsSafeError) || error.code !== "helper-unavailable") throw error;
  }
  if (available) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(fs.realpathSync(rootDir),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch {
      available = false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  if (available) return false;
  const before = fs.readdirSync(rootDir);
  const options = { rootDir, prefix: "unavailable-" };
  const expected = expect.objectContaining({ name: "FsSafeError", code: "helper-unavailable" });
  await expect(tempWorkspace(options)).rejects.toEqual(expected);
  expect(() => tempWorkspaceSync(options)).toThrowError(expected);
  expect(fs.readdirSync(rootDir)).toEqual(before);
  return true;
}
