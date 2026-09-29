import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fileObservation } from "../src/file-observation.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
});

it.each([false, true])("keeps root failure ahead of the final parent fence after collecting stat metadata (fallback=%s)", async fallback => {
  configureFsSafeNative({ mode: "off" });
  const rootDir = await tempRoot("fs-safe-stat-final-fence-order-");
  const parent = path.join(rootDir, "selected");
  const relative = "selected/value";
  const target = path.join(parent, "value");
  await fs.mkdir(parent);
  await fs.writeFile(target, "unchanged metadata source");
  const capability = await root(rootDir);
  const before = await fs.stat(target, { bigint: true });
  const rootFailure = Object.assign(new Error("root fence denied"), { code: "EACCES" });
  const parentFailure = Object.assign(new Error("parent fence denied"), { code: "EIO" });
  const lstat = fsSync.lstatSync.bind(fsSync);
  const events: string[] = [];
  let initialCalls = 0, observationCalls = 0;
  __setFsSafeTestHooksForTest({
    ...(fallback ? { beforeRootStatInitialObservation: () => { initialCalls += 1; } } : {}),
    beforeRootStatObservation(candidate) {
      expect(candidate).toBe(target);
      observationCalls += 1;
      // Arm both failures only after admission; the final leaf sample stays real.
      vi.spyOn(fsSync, "lstatSync").mockImplementation((file, options) => {
        const pathname = path.resolve(String(file));
        if (pathname === capability.rootReal) {
          events.push("root-fence");
          throw rootFailure;
        }
        if (pathname === parent) {
          events.push("parent-fence");
          throw parentFailure;
        }
        const stat = lstat(file, options as never);
        if (pathname === target) events.push("leaf-sample");
        return stat;
      });
    },
  });
  const observation = fileObservation();
  try {
    const caught = await observation.run(() => capability.stat(relative)).then(
      () => ({ rejected: false as const }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
    expect(caught.rejected).toBe(true);
    if (!caught.rejected) throw new Error("metadata escaped a failed final root fence");
    expect(caught.error).toMatchObject({ code: "path-mismatch", cause: rootFailure });
    expect((caught.error as Error).cause === rootFailure).toBe(true);
    expect(initialCalls).toBe(fallback ? 1 : 0);
    expect(observationCalls).toBe(1);
    expect(events[0]).toBe("leaf-sample");
    expect(events.at(-1)).toBe("root-fence");
    expect(events.filter(event => event === "root-fence")).toHaveLength(1);
    expect(events).not.toContain("parent-fence");
    expect(observation.has(caught.error, `stat-leaf-missing:${target}`)).toBe(false);
    expect(observation.has(caught.error, `stat-leaf-changed:${target}`)).toBe(false);
  } finally {
    vi.restoreAllMocks();
    __setFsSafeTestHooksForTest();
  }
  const after = await fs.stat(target, { bigint: true });
  expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  expect(await fs.readFile(target, "utf8")).toBe("unchanged metadata source");
});
