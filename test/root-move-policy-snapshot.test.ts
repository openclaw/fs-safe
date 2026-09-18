import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mutationPolicy from "../src/deny-mutations.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native platform jobs provide the addon. */ }
const supported = ["darwin", "linux", "win32"].includes(process.platform);

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

function configure(mode: "off" | "require") {
  configureFsSafeNative({ mode });
  if (native) __setNativeLoaderForTest(() => native!);
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
}

async function fixture() {
  const directory = await tempRoot("fs-safe-move-policy-snapshot-");
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  await fs.writeFile(source, "owned bytes");
  return { directory, source, target };
}

describe.each(["off", "require"] as const)("Root.move policy snapshot (%s)", mode => {
  describe.runIf(mode === "off" ? supported : native !== undefined).each(["defaults", "call"] as const)(
    "%s policy", origin => {
      it.each(["paths", "prefixes"] as const)("retains denied %s entries cleared after the public call", async field => {
        configure(mode);
        for (const endpoint of ["source", "target"] as const) {
          const f = await fixture();
          const entries = [f[endpoint]];
          const policy = { [field]: entries };
          const scoped = await root(f.directory, origin === "defaults" ? { denyMutations: policy } : {});
          const moving = scoped.move("source", "target", origin === "call" ? { denyMutations: policy } : {});
          entries.length = 0;
          await expect(moving).rejects.toMatchObject({ code: "denied-path" });
          expect(await fs.readFile(f.source, "utf8")).toBe("owned bytes");
          await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });

      it("keeps admitted policy stable across the real final authority callback", async () => {
        configure(mode);
        const f = await fixture();
        const protectedPath = path.join(f.directory, "protected");
        const entries = [protectedPath];
        const policy = { paths: entries };
        const scoped = await root(f.directory, origin === "defaults" ? { denyMutations: policy } : {});
        const checks = vi.spyOn(mutationPolicy, "assertMutationNotDenied");
        let authorized = false;

        await scoped.move("source", "target", {
          ...(origin === "call" ? { denyMutations: policy } : {}),
          assertBeforeMutation: () => { entries.splice(0, 1, f.source); authorized = true; },
        });

        expect(authorized).toBe(true);
        expect(await fs.readFile(f.target, "utf8")).toBe("owned bytes");
        await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
        const admittedPolicies = checks.mock.calls.flatMap(([, admitted]) => admitted ? [admitted] : []);
        expect(admittedPolicies.length).toBeGreaterThan(0);
        for (const admitted of admittedPolicies) {
          expect(admitted).not.toBe(policy);
          expect(admitted.paths).toEqual([protectedPath]);
          expect(Object.isFrozen(admitted.paths)).toBe(true);
        }

        // A new call observes the caller's new policy; the completed call keeps
        // its admitted snapshot. Live revocation belongs to the callback.
        await fs.writeFile(f.source, "later bytes");
        await expect(scoped.move("source", "second", origin === "call" ? { denyMutations: policy } : {}))
          .rejects.toMatchObject({ code: "denied-path" });
        expect(await fs.readFile(f.source, "utf8")).toBe("later bytes");
      });
    },
  );
});

it.runIf(supported)("retains the policy snapshot across the actual lazy command import yield", async () => {
  configure("off");
  const f = await fixture();
  const protectedPath = path.join(f.directory, "protected");
  const entries = [protectedPath];
  const policy = { paths: entries };
  const scoped = await root(f.directory, { denyMutations: policy });
  const checks = vi.spyOn(mutationPolicy, "assertMutationNotDenied");
  const lstat = fsSync.lstatSync.bind(fsSync);
  let admissionHookRan = false;
  let queued = false;
  let changed = false;
  __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: () => { admissionHookRan = true; } });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const result = lstat(...args);
    if (admissionHookRan && !queued && String(args[0]) === f.source && typeof result.dev === "bigint") {
      queued = true;
      // Source selection/pinning is synchronous until the command import.
      queueMicrotask(() => { entries.splice(0, 1, f.source); changed = true; });
    }
    return result;
  });

  await scoped.move("source", "target", { assertBeforeMutation: () => { expect(changed).toBe(true); } });

  expect(queued).toBe(true);
  expect(await fs.readFile(f.target, "utf8")).toBe("owned bytes");
  for (const [, admitted] of checks.mock.calls) {
    expect(admitted?.paths).toEqual([protectedPath]);
    expect(Object.isFrozen(admitted?.paths)).toBe(true);
  }
  expect(entries).toEqual([f.source]);
});
