import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __cleanupRegisteredTempPathsForTest();
});

it.each(["temp", "output"] as const)(
  "%s snapshots producer isolation before its first awaited directory operation",
  async (api) => {
    const root = await tempRoot("fs-safe-isolation-snapshot-");
    const dir = path.join(root, "output");
    const final = path.join(dir, "final.bin");
    const realMkdir = fs.mkdir.bind(fs);
    let reachedGate!: () => void;
    let releaseGate!: () => void;
    const atGate = new Promise<void>((resolve) => { reachedGate = resolve; });
    const released = new Promise<void>((resolve) => { releaseGate = resolve; });
    let gated = false;
    const realMkdirSync = fsSync.mkdirSync.bind(fsSync);
    vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
      const result = realMkdirSync(...args);
      if (api === "output" && !gated && path.resolve(String(args[0])) === dir) {
        gated = true;
        reachedGate();
      }
      return result;
    });
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await realMkdir(...args);
      if (!gated && path.resolve(String(args[0])) === dir) {
        gated = true;
        reachedGate();
        await released;
      }
      return result;
    });

    let producerIsolation: "private-directory" | undefined = "private-directory";
    let isolationReads = 0;
    let produced = "";
    const write = async (candidate: string) => {
      produced = candidate;
      await fs.writeFile(candidate, "isolated");
    };
    const pending = api === "temp"
      ? writeSiblingTempFile({
          dir,
          writeTemp: write,
          resolveFinalPath: () => final,
          get producerIsolation() {
            isolationReads++;
            return producerIsolation;
          },
        })
      : writeExternalFileWithinRoot({
          rootDir: root,
          path: "output/final.bin",
          staging: "sibling",
          write,
          get producerIsolation() {
            isolationReads++;
            return producerIsolation;
          },
        });

    await atGate;
    producerIsolation = undefined;
    releaseGate();
    await expect(pending).resolves.toMatchObject(api === "temp"
      ? { filePath: final }
      : { path: final });
    expect(isolationReads).toBe(1);
    expect(path.dirname(produced)).not.toBe(dir);
    expect(path.dirname(path.dirname(produced))).toBe(dir);
    await expect(fs.readFile(final, "utf8")).resolves.toBe("isolated");
  },
);

