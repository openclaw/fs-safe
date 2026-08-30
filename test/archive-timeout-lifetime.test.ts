import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
});

describe("archive timeout lifetime", () => {
  it("preserves prompt deadlines around non-mutating work", async () => {
    let finished = false;
    const startedAt = Date.now();

    await expect(
      withExtractionDeadline(1, "extract tar", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        finished = true;
      }),
    ).rejects.toThrow("extract tar timed out after 1ms");

    expect(Date.now() - startedAt).toBeLessThan(75);
    expect(finished).toBe(false);
  });

  it("joins a destination mutation already in flight at the deadline", async () => {
    let enterMutation: (() => void) | undefined;
    let releaseMutation: (() => void) | undefined;
    let settled = false;
    const mutationEntered = new Promise<void>((resolve) => {
      enterMutation = resolve;
    });
    const mutationRelease = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const operation = withExtractionDeadline(10, "extract tar", async (deadline) => {
      await deadline.ownDestinationMutation(async () => {
        enterMutation?.();
        await mutationRelease;
        deadline.check();
      });
    });
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await mutationEntered;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    releaseMutation?.();
    await expect(operation).rejects.toThrow("extract tar timed out after 10ms");
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
        const stagedDirs: string[] = [];
        const realMkdtemp = fs.mkdtemp.bind(fs);
        vi.spyOn(fs, "mkdtemp").mockImplementation(
          async (...args: Parameters<typeof fs.mkdtemp>) => {
            const dir = await realMkdtemp(...args);
            if (String(args[0]).includes("fs-safe-archive")) stagedDirs.push(dir);
            return dir;
          },
        );
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

        const extraction = extractArchive({
          archivePath,
          destDir: destination,
          kind,
          timeoutMs: 1_000,
        });
        await mergeEntered;
        await expect(extraction).rejects.toThrow(`extract ${kind} timed out after 1000ms`);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(outputPath, "trusted-recovery");

        releaseMerge?.();
        expect(stagedDirs.length).toBeGreaterThan(0);
        await expect
          .poll(async () => {
            const existing = await Promise.all(
              stagedDirs.map(async (dir) => await fs.access(dir).then(
                () => true,
                () => false,
              )),
            );
            return existing.every((value) => !value);
          })
          .toBe(true);
        await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("trusted-recovery");
      },
      10_000,
    );
  });
});
