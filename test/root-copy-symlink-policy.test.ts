import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root, type Root } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const parentPolicy = "follow-parents-within-root" as const;
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-copy-symlink-policy-");
  const sourceDirectory = path.join(directory, "source");
  const destinationDirectory = path.join(directory, "destination");
  const sourceActual = path.join(sourceDirectory, "actual");
  const destinationActual = path.join(destinationDirectory, "actual");
  await fs.mkdir(sourceActual, { recursive: true });
  await fs.mkdir(destinationActual, { recursive: true });
  await fs.symlink(sourceActual, path.join(sourceDirectory, "alias"), "dir");
  await fs.symlink(destinationActual, path.join(destinationDirectory, "alias"), "dir");
  const sourcePath = path.join(sourceActual, "input");
  await fs.writeFile(sourcePath, "source payload");
  return {
    sourcePath,
    destinationActual,
    target: path.join(destinationActual, "target"),
    protectedPath: path.join(destinationActual, "protected"),
    previousPath: path.join(destinationActual, "previous"),
    source: await root(sourceDirectory, { symlinks: parentPolicy }),
    destination: await root(destinationDirectory, { mutationSymlinks: parentPolicy }),
  };
}

describe.skipIf(process.platform === "win32")("Root.copyIn parent symlink policy", () => {
  for (const mode of ["off", "require"] as const) {
    describe.skipIf(mode === "require" && !nativeAvailable)(`native ${mode}`, () => {
      it.each([false, true])(
        "rejects a destination leaf symlink introduced during source verification (overwrite=%s)",
        async overwrite => {
          configureFsSafeNative({ mode });
          const copy = await fixture();
          await fs.writeFile(copy.protectedPath, "other owner's content");
          if (overwrite) await fs.writeFile(copy.target, "previous destination");
          let inserted = false;
          const source: Pick<Root, "open" | "stat"> = {
            open: copy.source.open.bind(copy.source),
            async stat() {
              const result = await copy.source.stat(".");
              if (!inserted) {
                if (overwrite) await fs.rename(copy.target, copy.previousPath);
                await fs.symlink(copy.protectedPath, copy.target, "file");
                inserted = true;
              }
              return result;
            },
          };
          const onDestinationPublished = vi.fn();

          await expect(copy.destination.copyIn("alias/target", {
            root: source, relativePath: "alias/input",
          }, { overwrite, clone: "never", onDestinationPublished })).rejects.toMatchObject({ code: "symlink" });

          expect(inserted).toBe(true);
          expect(onDestinationPublished).not.toHaveBeenCalled();
          expect(await fs.readlink(copy.target)).toBe(copy.protectedPath);
          expect(await fs.readFile(copy.protectedPath, "utf8")).toBe("other owner's content");
          expect(await fs.readFile(copy.sourcePath, "utf8")).toBe("source payload");
          if (overwrite) expect(await fs.readFile(copy.previousPath, "utf8")).toBe("previous destination");
          expect((await fs.readdir(copy.destinationActual)).sort()).toEqual(
            overwrite ? ["previous", "protected", "target"] : ["protected", "target"],
          );
        },
      );

      it("copies between contained parent aliases through a narrow source capability", async () => {
        configureFsSafeNative({ mode });
        const copy = await fixture();
        const source: Pick<Root, "open" | "stat"> = {
          open: copy.source.open.bind(copy.source),
          stat: copy.source.stat.bind(copy.source),
        };

        await copy.destination.copyIn("alias/target", {
          root: source, relativePath: "alias/input",
        }, { overwrite: false, clone: "never" });

        expect(await fs.readFile(copy.target, "utf8")).toBe("source payload");
        expect(await fs.readFile(copy.sourcePath, "utf8")).toBe("source payload");
        expect(await fs.readdir(copy.destinationActual)).toEqual(["target"]);
      });
    });
  }
});
