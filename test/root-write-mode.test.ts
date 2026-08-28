import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";

let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  // JS-only jobs may omit bindings; an explicitly required native run must fail.
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

const { tempRoot } = useTempDirs();
const payload = "mode-zero-proof";

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

type ModeSource = "root default" | "per-call";
type WriteOperation = "write new" | "write replacement" | "write overwrite:false" | "create";
type WriteCase = { operation: WriteOperation; modeSource: ModeSource; mode: number };

const writeOperations: WriteOperation[] = [
  "write new", "write replacement", "write overwrite:false", "create",
];
const modeSources: ModeSource[] = ["root default", "per-call"];
const writeCases: WriteCase[] = [
  ...modeSources.flatMap((modeSource) =>
    writeOperations.map((operation) => ({ operation, modeSource, mode: 0o000 })),
  ),
  { operation: "write new", modeSource: "per-call", mode: 0o200 },
  { operation: "write replacement", modeSource: "root default", mode: 0o200 },
  { operation: "write overwrite:false", modeSource: "per-call", mode: 0o200 },
  { operation: "create", modeSource: "root default", mode: 0o200 },
  { operation: "write replacement", modeSource: "per-call", mode: 0o600 },
  { operation: "create", modeSource: "root default", mode: 0o600 },
];

function modeOptions(mode: number, modeSource: ModeSource) {
  return {
    defaults: { mode: modeSource === "root default" ? mode : mode === 0o600 ? 0o000 : 0o600 },
    options: modeSource === "per-call" ? { mode } : {},
  };
}

async function expectPublished(directory: string, mode: number, operation: Promise<void>) {
  // Inspect publication even when the API rejects after committing the bytes.
  await expect.soft(operation).resolves.toBeUndefined();
  const target = path.join(directory, "target");
  const published = await fs.lstat(target);
  expect(published.isFile()).toBe(true);
  expect.soft(published.mode & 0o777).toBe(mode);
  expect(published.nlink).toBe(1);
  expect.soft(await fs.readdir(directory)).toEqual(["target"]);
  // Only the owned fixture becomes readable, after the call and mode assertion.
  await fs.chmod(target, 0o600);
  expect.soft(await fs.readFile(target, "utf8")).toBe(payload);
}

for (const nativeMode of ["off", "require"] as const) {
  describe.skipIf(process.platform === "win32" || (nativeMode === "require" && !nativeAvailable))(
    `Root publication modes with native ${nativeMode}`,
    () => {
      it.skipIf(process.getuid?.() === 0)("keeps later reads and pre-existing destination access subject to OS permissions", async () => {
        configureFsSafeNative({ mode: nativeMode });
        const directory = await tempRoot("fs-safe-root-mode-access-");
        const safe = await root(directory);
        await expect(safe.write("target", payload, { mode: 0 })).resolves.toBeUndefined();
        await expect(safe.readText("target")).rejects.toMatchObject({ code: "EACCES" });
        await expect(safe.write("target", "replacement", { mode: 0o600 })).rejects.toMatchObject({ code: "EACCES" });
        expect((await fs.stat(path.join(directory, "target"))).mode & 0o777).toBe(0);
        await fs.chmod(path.join(directory, "target"), 0o600);
        expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe(payload);
        expect(await fs.readdir(directory)).toEqual(["target"]);
      });

      it.each(writeCases.map((entry) => ({ ...entry, octal: entry.mode.toString(8).padStart(3, "0") })))(
        "$operation honors $modeSource mode $octal",
        async ({ operation, modeSource, mode }) => {
          configureFsSafeNative({ mode: nativeMode });
          const directory = await tempRoot("fs-safe-root-write-mode-");
          if (operation === "write replacement") {
            await fs.writeFile(path.join(directory, "target"), "previous bytes", { mode: 0o600 });
          }
          const { defaults, options } = modeOptions(mode, modeSource);
          const safe = await root(directory, defaults);
          const pending = operation === "create"
            ? safe.create("target", payload, options)
            : safe.write("target", payload, {
                ...options,
                ...(operation === "write overwrite:false" ? { overwrite: false } : {}),
              });
          await expectPublished(directory, mode, pending);
        },
      );

      it.each(["create", "write overwrite:false"] as const)(
        "%s with mode 000 preserves an existing target",
        async (operation) => {
          configureFsSafeNative({ mode: nativeMode });
          const directory = await tempRoot("fs-safe-root-mode-collision-");
          const target = path.join(directory, "target");
          await fs.writeFile(target, "existing", { mode: 0o600 });
          const original = await fs.stat(target);
          const safe = await root(directory, { mode: 0o000 });
          const pending = operation === "create"
            ? safe.create("target", payload)
            : safe.write("target", payload, { overwrite: false });
          await expect(pending).rejects.toMatchObject({ code: "already-exists" });
          expect((await fs.stat(target)).mode).toBe(original.mode);
          expect(await fs.readFile(target, "utf8")).toBe("existing");
          expect(await fs.readdir(directory)).toEqual(["target"]);
        },
      );

      it.each([
        ...modeSources.flatMap((modeSource) =>
          [false, true].map((replacement) => ({ modeSource, replacement, mode: 0o000 })),
        ),
        { modeSource: "per-call" as const, replacement: true, mode: 0o200 },
        { modeSource: "root default" as const, replacement: false, mode: 0o600 },
      ].map((entry) => ({ ...entry, octal: entry.mode.toString(8).padStart(3, "0") })))(
        "copyIn honors $modeSource mode $octal (replacement: $replacement)",
        async ({ modeSource, replacement, mode }) => {
          configureFsSafeNative({ mode: nativeMode });
          const directory = await tempRoot("fs-safe-root-copy-mode-");
          const source = path.join(await tempRoot("fs-safe-root-copy-mode-source-"), "source");
          await fs.writeFile(source, payload, { mode: 0o600 });
          if (replacement) {
            await fs.writeFile(path.join(directory, "target"), "previous bytes", { mode: 0o600 });
          }
          const { defaults, options } = modeOptions(mode, modeSource);
          const safe = await root(directory, defaults);
          await expectPublished(directory, mode, safe.copyIn("target", source, options));
          expect(await fs.readFile(source, "utf8")).toBe(payload);
        },
      );
    },
  );
}

describe.skipIf(process.platform === "win32")("Root publication mode with rename compatibility", () => {
  it.each([0o000, 0o600])("honors mode %i and releases the compatibility lock", async (mode) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-root-mode-compatibility-");
    const safe = await root(directory, { mode, renameIdentity: "verify-content-with-lock" });
    await expectPublished(directory, mode, safe.write("target", payload));
  });
});
