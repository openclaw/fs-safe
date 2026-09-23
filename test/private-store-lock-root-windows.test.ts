import type { BigIntStats } from "node:fs";
import { afterEach, expect, vi } from "vitest";
import { openPrivateStoreLockRoot } from "../src/file-store-boundary.js";
import * as context from "../src/root-context.js";
import * as secretFile from "../src/secret-file.js";
import { itWin32 } from "./helpers/vitest.js";

afterEach(() => vi.restoreAllMocks());

itWin32.each(["?", "."])("retains an admitted %s namespace root without another root lookup", async namespace => {
  const realPath = "C:\\";
  const rootDir = `\\\\${namespace}\\${realPath}`;
  const stat = { dev: 1n, ino: (1n << 56n) + 3n } as BigIntStats;
  const parentGuard = { dir: rootDir, realPath, stat };
  const params = { rootDir, filePath: `${rootDir}state.json` };
  const prepare = vi.spyOn(secretFile, "prepareSecretFileWrite").mockResolvedValue({
    mode: 0o600, rootGuard: parentGuard, parentGuard,
    fileName: "state.json", finalFilePath: `${realPath}state.json`,
  });
  const lookup = vi.spyOn(context, "resolveRootContext").mockRejectedValue(new Error("admitted root must not be recaptured"));

  const admitted = await openPrivateStoreLockRoot(params);

  expect(prepare).toHaveBeenCalledExactlyOnceWith(params);
  expect(admitted.rootDir).toBe(rootDir);
  expect(admitted.rootReal).toBe(realPath);
  expect(admitted.rootWithSep).toBe(realPath);
  expect(admitted.defaults).toEqual({ hardlinks: "reject" });
  expect(lookup).not.toHaveBeenCalled();
});
