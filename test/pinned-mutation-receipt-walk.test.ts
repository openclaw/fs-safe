import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
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

describe.runIf(process.platform !== "win32" && !process.versions.bun)("fallback receipt race seams", () => {
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
