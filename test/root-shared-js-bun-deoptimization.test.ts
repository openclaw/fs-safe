import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { observeMutationAuthorizations } from "./helpers/root-shared-js-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function authorizationProfile(forceComponentWalk: boolean): Promise<number[]> {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-shared-policy-bun-deopt-");
  const safe = await root(directory);
  const counts = observeMutationAuthorizations();
  const observed: number[] = [];
  let previous = 0;

  for (const depth of [1, 8, 32]) {
    const parent = path.join(
      directory,
      `depth-${depth}`,
      ...Array.from({ length: depth - 1 }, (_, index) => `d${index}`),
    );
    const target = path.join(parent, "value");
    const content = `original-${depth}`;
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(target, content);
    const opened = await safe.openWritable(path.relative(directory, target), {
      writeMode: "update",
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject",
      assertBeforeMutation: forceComponentWalk ? () => {} : undefined,
    });
    await opened.handle.close();
    expect(await fs.readFile(target, "utf8")).toBe(content);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    observed.push(total - previous);
    previous = total;
  }

  return observed;
}

describe.runIf(Boolean(process.versions.bun))("Bun shared-write deoptimization", () => {
  it("matches a forced component walk and keeps authorization depth-sensitive", async () => {
    const ordinary = await authorizationProfile(false);
    vi.restoreAllMocks();
    const forced = await authorizationProfile(true);

    expect(ordinary).toEqual(forced);
    expect(ordinary[0]).toBeGreaterThan(2);
    expect(ordinary[1]).toBeGreaterThan(ordinary[0]!);
    expect(ordinary[2]).toBeGreaterThan(ordinary[1]!);
  });
});
