import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive } from "../src/archive.js";
import { withExtractionDeadline } from "../src/archive-deadline.js";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { useTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

const { tempRoot: createTempRoot } = useTempDirs();
const backends = native ? (["native", "javascript"] as const) : (["javascript"] as const);

function useBackend(backend: (typeof backends)[number]): void {
  if (backend === "native") {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
  } else {
    configureFsSafeNative({ mode: "off" });
  }
}

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("archive timeout lifetime", () => {
  it("waits for non-cooperative owned work to quiesce after the deadline", async () => {
    let release: (() => void) | undefined;
    let finished = false;
    let settled = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = withExtractionDeadline(1, "extract tar", async () => {
      await blocked;
      finished = true;
    });
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(finished).toBe(false);

    release?.();
    await expect(operation).rejects.toThrow("extract tar timed out after 1ms");
    expect(finished).toBe(true);
  });

  describe.each(backends)("%s extraction", (backend) => {
    it.each(["zip", "tar"] as const)(
      "quiesces the live %s merge before reporting timeout",
      async (kind) => {
        useBackend(backend);
        const root = await createTempRoot("fs-safe-archive-timeout-");
        const archivePath = path.join(root, `fixture.${kind}`);
        const destination = path.join(root, "destination");
        const outputDir = path.join(destination, "package");
        const outputPath = path.join(outputDir, "hello.txt");
        if (kind === "zip") {
          const zip = new JSZip();
          zip.file("package/hello.txt", "archive-content");
          await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
        } else {
          await fs.writeFile(
            archivePath,
            tarFixture([{ path: "package/hello.txt", body: "archive-content" }]),
          );
        }
        await fs.mkdir(destination);

        let enterMerge: (() => void) | undefined;
        let releaseMerge: (() => void) | undefined;
        let blocked = false;
        const mergeEntered = new Promise<void>((resolve) => {
          enterMerge = resolve;
        });
        const mergeRelease = new Promise<void>((resolve) => {
          releaseMerge = resolve;
        });
        __setFsSafeTestHooksForTest({
          async beforeArchiveOutputMutation(operation, targetPath) {
            if (!blocked && operation === "mkdir" && targetPath === outputDir) {
              blocked = true;
              enterMerge?.();
              await mergeRelease;
            }
          },
        });

        let settled = false;
        const extraction = extractArchive({
          archivePath,
          destDir: destination,
          kind,
          timeoutMs: 1_000,
        });
        void extraction.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await mergeEntered;
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        expect(settled).toBe(false);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(outputPath, "trusted-recovery");

        releaseMerge?.();
        await expect(extraction).rejects.toThrow(`extract ${kind} timed out after 1000ms`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("trusted-recovery");
      },
      10_000,
    );
  });
});
