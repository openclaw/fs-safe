import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { extractArchive } from "../src/archive.js";
import { pinNodeDirectoryForMode } from "../src/directory-mode-node.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
if (process.platform !== "win32" && !process.versions.bun) {
  try { nativeAvailable = !!__loadBundledNativeForTest().observeDirectoryFd; }
  catch (error) { if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error; }
}
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

for (const mode of ["off", "require"] as const) {
  describe.runIf(process.platform !== "win32" && (mode === "off" || nativeAvailable))(`archive ancestor observations (${mode})`, () => {
    for (const boundary of ["mkdir", "source-open", "source-identity", "source-close", "chmod"] as const) {
      it.each(["directory", "alias"] as const)(`rejects a %s ancestor substitution at ${boundary} with the original descendants retained`, async (swap) => {
        configureFsSafeNative({ mode });
        const base = await tempRoot("fs-safe-archive-ancestor-");
        const destDir = path.join(base, "destination");
        const ancestor = path.join(destDir, "a", "b");
        const deepest = path.join(ancestor, "c", "d");
        const parked = path.join(base, "parked");
        const target = path.join(deepest, "value");
        const archivePath = path.join(base, "fixture.zip");
        fs.mkdirSync(deepest, { recursive: true });
        fs.writeFileSync(target, "OLD");
        const original = fs.statSync(deepest, { bigint: true });
        const zip = new JSZip();
        zip.file("a/b/c/d/value", "NEW", { createFolders: false });
        fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
        let swapped = false;
        const replace = () => {
          if (swapped) return;
          swapped = true;
          fs.renameSync(ancestor, parked);
          if (swap === "alias") fs.symlinkSync(parked, ancestor, "dir");
          else {
            fs.mkdirSync(ancestor);
            fs.renameSync(path.join(parked, "c"), path.join(ancestor, "c"));
          }
          const retained = fs.statSync(deepest, { bigint: true });
          expect([retained.dev, retained.ino]).toEqual([original.dev, original.ino]);
        };
        __setFsSafeTestHooksForTest({
          beforeArchiveOutputMutation(operation, candidate) {
            if (candidate === deepest && operation === boundary && fs.existsSync(deepest)) replace();
          },
          afterOpenedPathIdentityCheck(candidate) {
            if (boundary === "source-identity" && candidate.endsWith(`${path.sep}a${path.sep}b${path.sep}c${path.sep}d${path.sep}value`) && candidate !== target) replace();
          },
          afterOpen(candidate, handle) {
            if (!candidate.endsWith(`${path.sep}a${path.sep}b${path.sep}c${path.sep}d${path.sep}value`) || candidate === target) return;
            if (boundary === "source-open") replace();
            if (boundary === "source-close") {
              const close = handle.close.bind(handle);
              handle.close = async () => { await close(); replace(); };
            }
          },
        });
        await expect(extractArchive({ archivePath, destDir, timeoutMs: 10_000, durable: false })).rejects.toMatchObject({
          code: "destination-symlink-traversal",
        });
        expect(swapped).toBe(true);
        if (boundary === "mkdir") expect(fs.readFileSync(target, "utf8")).toBe("OLD");
        // Late rejection preserves any admitted file already published.
        if (boundary === "chmod") expect(fs.readFileSync(target, "utf8")).toBe("NEW");
      });
    }
  });
}

describe.runIf(nativeAvailable)("retained canonical directory verifier", () => {
  it("falls back after native mode changes and rejects use after close", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-archive-observer-owner-");
    const owner = await pinNodeDirectoryForMode(directory, { canonicalPath: directory });
    try {
      expect(await owner.verifyCanonical!()).toBe(true);
      configureFsSafeNative({ mode: "off" });
      expect(await owner.verifyCanonical!()).toBe(false);
    } finally { await owner.close(); }
    await expect(owner.verifyCanonical!()).rejects.toMatchObject({ code: "path-mismatch" });
  });
});
