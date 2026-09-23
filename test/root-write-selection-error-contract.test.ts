import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { resolveRootContext } from "../src/root-context.js";
import {
  assertRootWriteSelectionSync,
  createRootWriteSelectionForFd,
  prepareGuardedRootWritePathSelection,
  resolveGuardedWriteTargetInRoot,
} from "../src/root-write-admission.js";
import { assertPreparedRootWriteParentCurrent, prepareSharedRootWriteTarget } from "../src/root-write-complete-parent.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

it.skipIf(Boolean(process.versions.bun)).each([
  { name: "undefined", cause: undefined }, { name: "null", cause: null },
  { name: "string", cause: "lookup refused" }, { name: "object", cause: { code: "EIO" } },
  { name: "Error", cause: new Error("lookup refused") },
  { name: "hostile object", cause: Object.defineProperty({}, "code", { get() { throw new Error("cause code inspected"); } }) },
  { name: "upstream mismatch", cause: new FsSafeError("path-mismatch", "upstream identity failure") },
])("preserves $name lookup failures for prepared and retained write selection", async ({ cause }) => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-selection-errors-");
  const root = await resolveRootContext(directory);
  const target = path.join(root.rootReal, "value");
  await fs.writeFile(target, "original");
  const guardedTarget = await resolveGuardedWriteTargetInRoot(root, {
    relativePath: "value", mutationSymlinks: "reject",
    denyMutations: { prefixes: [path.join(root.rootReal, "denied")] },
  });
  const prepared = await prepareSharedRootWriteTarget(root, { relativePath: "value", guardedTarget });
  expect(prepared.preparedParent).toBeDefined();
  const selection = await prepareGuardedRootWritePathSelection(guardedTarget, target, target, prepared.preparedParent);
  expect(selection).toBeDefined();
  const handle = await fs.open(target, "r");
  try {
    const retained = createRootWriteSelectionForFd(selection!, handle.fd);
    const lstat = fsSync.lstatSync;
    const observations: string[] = [];
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((pathname: fsSync.PathLike, ...args: unknown[]) => {
      observations.push(String(pathname));
      if (pathname === target) throw cause;
      return Reflect.apply(lstat, fsSync, [pathname, ...args]);
    }) as typeof fsSync.lstatSync);
    for (const assertCurrent of [
      () => assertPreparedRootWriteParentCurrent(prepared.preparedParent!, true),
      () => assertRootWriteSelectionSync(root, retained, true, handle.fd),
    ]) {
      observations.length = 0;
      let failure: unknown;
      try { assertCurrent(); } catch (error) { failure = error; }
      expect(observations.at(-1)).toBe(target);
      expect(observations.filter(observed => observed === target)).toHaveLength(1);
      if (cause instanceof FsSafeError) {
        expect(failure).toBe(cause);
      } else {
        expect(failure).toMatchObject({
          name: "FsSafeError", code: "path-mismatch", category: "policy",
          message: "write target changed during operation", details: undefined,
        });
        expect(Object.hasOwn(failure as object, "details")).toBe(true);
        expect(Object.hasOwn(failure as object, "cause")).toBe(true);
        expect(Object.getOwnPropertyDescriptor(failure, "cause")?.value).toBe(cause instanceof Error ? cause : undefined);
      }
      expect((await handle.stat()).isFile()).toBe(true);
    }
  } finally {
    vi.restoreAllMocks();
    await handle.close();
  }
  expect(await fs.readFile(target, "utf8")).toBe("original");
  expect(await fs.readdir(root.rootReal)).toEqual(["value"]);
});
