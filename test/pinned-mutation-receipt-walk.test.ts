import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { mkdirPathComponentsWithGuards } from "../src/guarded-mkdir.js";
import { createPathSegmentRoute, joinPathSegmentRoute } from "../src/path-segment-route.js";
import * as context from "../src/root-context.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
if (process.platform === "linux") {
  try { __loadBundledNativeForTest(); nativeAvailable = true; } catch (error) {
    if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("immutable path segment routes", () => {
  it("normalizes each selected suffix once without copying segment arrays", () => {
    const segments = Array.from({ length: 128 }, (_, index) => `level-${index}`);
    const route = createPathSegmentRoute(segments);
    const base = path.parse(process.cwd()).root;
    expect(path.relative(base, joinPathSegmentRoute(base, route, 64, "value")).split(path.sep))
      .toEqual([...segments.slice(64), "value"]);
    expect(Object.isFrozen(route.offsets)).toBe(true);
    const join = vi.spyOn(path, "join");
    join.mockClear();
    for (let offset = 0; offset <= segments.length; offset += 1) {
      joinPathSegmentRoute(base, route, offset, "value");
    }
    expect(join).toHaveBeenCalledTimes(segments.length + 1);
    expect(join.mock.calls.every((args) => args.length <= 3)).toBe(true);
  });
});

for (const mode of ["off", "require"] as const) {
  describe.runIf(process.platform !== "win32" && !process.versions.bun &&
    (mode === "off" || nativeAvailable))(`mutation receipt walk (${mode})`, () => {
    it.each(["write", "create", "copyIn", "staged-stream"] as const)(
      "%s keeps full route admissions bounded as missing-parent depth increases", async (operation) => {
        configureFsSafeNative({ mode });
        const directory = await tempRoot("fs-safe-policy-walk-depth-");
        const source = path.join(directory, "source");
        await fs.writeFile(source, "payload");
        const scoped = await root(directory);
        const resolve = vi.spyOn(context, "resolvePathInRoot");
        const counts: number[] = [];
        for (const depth of [1, 8, 24]) {
          const relative = [...Array.from({ length: depth }, (_, index) => `d${depth}-${index}`), "value"].join("/");
          const options = {
            durable: false, mutationSymlinks: "reject" as const,
            denyMutations: { prefixes: [path.join(directory, "protected", "missing")] },
          };
          resolve.mockClear();
          if (operation === "copyIn") await scoped.copyIn(relative, source, options);
          else if (operation === "create") await scoped.create(relative, "payload", options);
          else if (operation === "staged-stream") {
            await scoped.create(relative, (async function* () { yield Buffer.from("payload"); })(), options);
          } else await scoped.write(relative, "payload", options);
          counts.push(resolve.mock.calls.length);
          expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe("payload");
        }
        expect(counts[0]).toBeGreaterThan(0);
        expect(counts[1]).toBe(counts[0]);
        expect(counts[2]).toBe(counts[0]);
      },
    );

    it("continues calling live authority for every mkdir and stops before staging", async () => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-policy-walk-authority-");
      const scoped = await root(directory);
      const revoked = new Error("authority revoked");
      let stopped = false;
      await expect(scoped.write("one/two/three/value", "payload", {
        mutationSymlinks: "reject", durable: false,
        assertBeforeMutation() {
          if (fsSync.existsSync(path.join(directory, "one/two"))) {
            stopped = true;
            throw revoked;
          }
        },
      })).rejects.toBe(revoked);
      expect(stopped).toBe(true);
      expect(await fs.readdir(path.join(directory, "one/two"))).toEqual([]);
    });
  });
}

describe.runIf(process.platform !== "win32" && !process.versions.bun && nativeAvailable)(
  "native direct-child receipt provenance",
  () => {
    it("deopts collisions, missing helpers, and nonboolean helpers to full ordered admission", async () => {
      const binding = __loadBundledNativeForTest();
      const mkdirChild = binding.mkdirChildBeneath;
      expect(mkdirChild).toBeTypeOf("function");
      if (!mkdirChild) throw new Error("native direct-child mkdir is unavailable");
      const results: Array<{ scenario: string; resolves: number; childCalls: number; legacyCalls: number }> = [];
      for (const scenario of ["exclusive", "collision", "missing", "nonboolean"] as const) {
        let childCalls = 0;
        let legacyCalls = 0;
        const candidate: NativeBinding = {
          ...binding,
          mkdirBeneath(...args) {
            legacyCalls += 1;
            binding.mkdirBeneath(...args);
          },
          mkdirChildBeneath(...args) {
            childCalls += 1;
            if (scenario === "collision" && childCalls === 1) {
              binding.mkdirBeneath(...args);
              return false;
            }
            const created = mkdirChild.call(binding, ...args);
            return scenario === "nonboolean" ? undefined as never : created;
          },
        };
        if (scenario === "missing") delete candidate.mkdirChildBeneath;
        __setNativeLoaderForTest(() => candidate);
        configureFsSafeNative({ mode: "require" });
        const directory = await tempRoot(`fs-safe-policy-native-${scenario}-`);
        const scoped = await root(directory);
        const resolve = vi.spyOn(context, "resolvePathInRoot");
        await scoped.write("one/two/value", "payload", {
          mutationSymlinks: "reject",
          durable: false,
        });
        results.push({
          scenario,
          resolves: resolve.mock.calls.length,
          childCalls,
          legacyCalls,
        });
        resolve.mockRestore();
        expect(await fs.readFile(path.join(directory, "one/two/value"), "utf8")).toBe("payload");
      }
      const [exclusive, collision, missing, nonboolean] = results;
      expect(exclusive).toMatchObject({ scenario: "exclusive", childCalls: 2, legacyCalls: 0 });
      expect(exclusive!.resolves).toBeGreaterThan(0);
      expect(collision).toEqual({
        scenario: "collision", resolves: exclusive!.resolves + 1, childCalls: 2, legacyCalls: 0,
      });
      expect(missing).toEqual({
        scenario: "missing", resolves: exclusive!.resolves + 2, childCalls: 0, legacyCalls: 2,
      });
      expect(nonboolean).toEqual({
        scenario: "nonboolean", resolves: exclusive!.resolves + 2, childCalls: 2, legacyCalls: 2,
      });
    });
  },
);

describe.runIf(process.platform !== "win32" && !process.versions.bun)("fallback receipt race seams", () => {
  it("retains one full target across deep simple routes and rebuilds after a redirect", async () => {
    const directory = await tempRoot("fs-safe-policy-walk-target-");
    const parts = Array.from({ length: 24 }, (_, index) => `level-${index}`);
    const parentPath = path.join(directory, ...parts);
    const targetPath = path.join(parentPath, "value");
    const retained: (string | undefined)[] = [];
    const receipt = Object.freeze({});
    await mkdirPathComponentsWithGuards({
      rootReal: directory,
      targetPath: parentPath,
      retainedTargetPath: targetPath,
      beforeCreateComponent(_component, prospectiveParent, retainedTarget) {
        expect(prospectiveParent).toBe(parentPath);
        retained.push(retainedTarget);
        return receipt;
      },
      beforeUseComponent(_component, prospectiveParent, retainedTarget) {
        expect(prospectiveParent).toBe(parentPath);
        retained.push(retainedTarget);
      },
    });
    expect(retained).toHaveLength(parts.length * 2);
    expect(new Set(retained)).toEqual(new Set([targetPath]));

    const real = path.join(directory, "real");
    const alias = path.join(directory, "alias");
    await fs.mkdir(real);
    await fs.symlink(real, alias, "dir");
    const redirectedParent = path.join(alias, "nested");
    const redirectedTarget = path.join(redirectedParent, "value");
    const redirects: Array<readonly [string, string | undefined]> = [];
    await mkdirPathComponentsWithGuards({
      rootReal: directory,
      targetPath: redirectedParent,
      retainedTargetPath: redirectedTarget,
      beforeCreateComponent(_component, prospectiveParent, retainedTarget) {
        redirects.push([prospectiveParent, retainedTarget]);
        return receipt;
      },
    });
    expect(redirects).toEqual([[path.join(real, "nested"), undefined]]);
  });

  it("refreshes an EEXIST child instead of claiming it as its own completed mkdir", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-policy-walk-eexist-");
    const scoped = await root(directory);
    const mkdir = fs.mkdir.bind(fs);
    let raced = false;
    vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
      if (!raced && String(args[0]) === path.join(directory, "one")) {
        raced = true;
        await mkdir(path.join(directory, "one"));
        throw Object.assign(new Error("concurrent directory"), { code: "EEXIST" });
      }
      return mkdir(...args);
    }) as typeof fs.mkdir);
    const resolve = vi.spyOn(context, "resolvePathInRoot");
    await scoped.write("one/two/value", "payload", { mutationSymlinks: "reject", durable: false });
    expect(raced).toBe(true);
    expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await fs.readFile(path.join(directory, "one/two/value"), "utf8")).toBe("payload");
  });

  it("checks a newly appearing deny spelling before creating the next component", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-policy-walk-deny-change-");
    const denied = path.join(directory, "deny-route");
    const scoped = await root(directory);
    __setFsSafeTestHooksForTest({
      async beforeRootFallbackMutation(operation, target) {
        if (operation === "mkdir" && target === path.join(directory, "one/two")) {
          await fs.symlink(path.join(directory, "one"), denied, "dir");
        }
      },
    });
    await expect(scoped.write("one/two/value", "payload", {
      denyMutations: { prefixes: [denied] }, durable: false,
    })).rejects.toMatchObject({ code: "denied-path" });
    expect(await fs.readdir(path.join(directory, "one"))).toEqual([]);
  });
});
