import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Native artifacts are built by dedicated platform jobs.
}

const { tempRoot } = useTempDirs();

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

describe.runIf(native)("native Root.move no-replace", () => {
  it("keeps a competitor created after real native parent admission", async () => {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
    const rootDir = await tempRoot("fs-safe-native-root-move-race-");
    await fs.mkdir(path.join(rootDir, "incoming"));
    await fs.mkdir(path.join(rootDir, "archive"));
    const source = path.join(rootDir, "incoming", "source");
    const target = path.join(rootDir, "archive", "target");
    await fs.writeFile(source, "source");
    let injected = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation) => {
        if (operation !== "move" || injected) return;
        injected = true;
        await fs.writeFile(target, "competitor");
      },
    });

    const scoped = await root(rootDir);
    await expect(scoped.move("incoming/source", "archive/target"))
      .rejects.toMatchObject({ code: "already-exists" });
    expect(injected).toBe(true);
    await expect(fs.readFile(source, "utf8")).resolves.toBe("source");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("competitor");
    console.log(JSON.stringify({
      proof: "root-move-native-no-replace-race",
      competitor: "preserved",
      source: "preserved",
    }));
  });
});
