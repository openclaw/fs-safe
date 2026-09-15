import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { root, type Root, type RootWriteOptions } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require" && process.platform === "linux") throw error;
}

afterEach(() => {
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

type Operation = "write" | "create" | "copyIn";

async function runOperation(
  safe: Root,
  operation: Operation,
  source: string,
  options: RootWriteOptions,
): Promise<void> {
  if (operation === "copyIn") {
    await safe.copyIn("allowed/nested/value", source, options);
  } else if (operation === "create") {
    await safe.create("allowed/nested/value", "replacement", options);
  } else {
    await safe.write("allowed/nested/value", "replacement", options);
  }
}

const routes = [
  { label: "POSIX fallback", mode: "off" as const, enabled: process.platform !== "win32" },
  {
    label: "Linux native",
    mode: "require" as const,
    enabled: process.platform === "linux" && nativeAvailable,
  },
];

for (const route of routes) {
  describe.runIf(route.enabled)(`${route.label} object-bound mutation admission`, () => {
    it("applies an exact parent deny only when that directory would actually be created", async () => {
      configureFsSafeNative({ mode: route.mode });
      const base = await tempRoot("fs-safe-native-policy-exact-parent-");
      const rootDir = path.join(base, "root");
      const existingParent = path.join(rootDir, "existing");
      const missingParent = path.join(rootDir, "missing");
      await fs.mkdir(existingParent, { recursive: true });
      const safe = await root(rootDir);

      await safe.write("existing/value", "allowed", {
        denyMutations: { paths: [existingParent] },
        durable: false,
      });
      expect(await fs.readFile(path.join(existingParent, "value"), "utf8")).toBe("allowed");

      await expect(safe.write("missing/value", "blocked", {
        denyMutations: { paths: [missingParent] },
        durable: false,
      })).rejects.toMatchObject({ code: "denied-path" });
      await expect(fs.lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(
      (["write", "create", "copyIn"] as const).flatMap((operation) =>
        [true, false].flatMap((mkdir) => [
          { operation, mkdir, policy: "deny" as const },
          { operation, mkdir, policy: "reject-symlink" as const },
        ]),
      ),
    )(
      "$operation (mkdir=$mkdir) rejects a post-preflight $policy redirect before changing its target",
      async ({ operation, mkdir, policy }) => {
        configureFsSafeNative({ mode: route.mode });
        const base = await tempRoot("fs-safe-native-policy-admission-");
        const rootDir = path.join(base, "root");
        const allowed = path.join(rootDir, "allowed");
        const savedAllowed = path.join(rootDir, "allowed-before-redirect");
        const redirected = path.join(rootDir, policy === "deny" ? "denied" : "redirected");
        const source = path.join(base, "source");
        await fs.mkdir(allowed, { recursive: true });
        await fs.mkdir(redirected, { recursive: true });
        await fs.writeFile(source, "copy replacement");
        await fs.writeFile(path.join(redirected, "sentinel"), "unchanged");
        if (!mkdir) {
          await fs.mkdir(path.join(allowed, "nested"));
          await fs.mkdir(path.join(redirected, "nested"));
          if (operation !== "create") {
            await fs.writeFile(path.join(allowed, "nested/value"), "allowed original");
            await fs.writeFile(path.join(redirected, "nested/value"), "protected original");
          }
        }

        const deniedPrefixes = policy === "deny" ? [redirected] : undefined;
        let redirectedAfterPreflight = false;
        __setFsSafeTestHooksForTest({
          async beforePinnedWriteParentAdmission() {
            if (redirectedAfterPreflight) return;
            redirectedAfterPreflight = true;
            await fs.rename(allowed, savedAllowed);
            await fs.symlink(path.basename(redirected), allowed, "dir");
            // The writer must retain the rules that its preflight used rather
            // than observing a caller mutation made at this race boundary.
            if (deniedPrefixes) deniedPrefixes.length = 0;
          },
        });

        const safe = await root(rootDir);
        const options: RootWriteOptions = {
          durable: false,
          mkdir,
          ...(policy === "deny"
            ? { denyMutations: { prefixes: deniedPrefixes } }
            : { mutationSymlinks: "reject" as const }),
        };
        await expect(runOperation(safe, operation, source, options)).rejects.toMatchObject({
          code: policy === "deny" ? "denied-path" : "symlink",
        });

        expect(redirectedAfterPreflight).toBe(true);
        expect(await fs.readFile(path.join(redirected, "sentinel"), "utf8")).toBe("unchanged");
        if (mkdir) {
          await expect(fs.lstat(path.join(redirected, "nested"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else if (operation === "create") {
          await expect(fs.lstat(path.join(redirected, "nested/value"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(await fs.readFile(path.join(redirected, "nested/value"), "utf8")).toBe(
            "protected original",
          );
        }
        expect((await fs.readdir(redirected)).some((name) => name.startsWith(".fs-safe-"))).toBe(false);
      },
    );
  });
}
