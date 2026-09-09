import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive } from "../src/archive.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { modeArchive } from "./helpers/archive-modes.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { observeArchiveFs } from "./helpers/archive-fs-counts.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

for (const backend of ["auto", "off"] as const) {
  describe.skipIf(backend === "auto" && !paxNative)(`archive sync budget: native ${backend}`, () => {
    for (const kind of ["tar", "zip"] as const) {
      it.each([undefined, false])(`${kind}: durable %s`, async (durable) => {
        if (paxNative) __setNativeLoaderForTest(() => paxNative);
        configureFsSafeNative({ mode: backend });
        const base = await tempRoot("fs-safe-fsync-budget-");
        const destDir = path.join(base, "output");
        await fs.mkdir(destDir);
        const archivePath = path.join(base, `input.${kind}`);
        await fs.writeFile(archivePath, await modeArchive(kind, [
          ...Array.from({ length: 3 }, (_, d) => ({ path: `d${d}/`, directory: true, mode: 0o755 })),
          ...Array.from({ length: 20 }, (_, f) => ({ path: `d${f % 3}/f${f}`, mode: 0o644 })),
        ]));
        const observed = await observeArchiveFs(base);
        await extractArchive({ archivePath, destDir, kind, timeoutMs: 30000, durable });
        // Native archive extraction has no Rust fsync; native pinned writers use
        // fs.fsyncSync, so all active sync routes are included in these counters.
        const diagnostic = JSON.stringify({ backend, kind, durable, calls: observed.total(), counts: observed.counts });
        expect(observed.syncs.filter((type) => type === "file").length, diagnostic).toBe(durable === false ? 0 : 20);
        const directorySyncs = observed.syncs.filter((type) => type === "directory").length;
        if (process.platform === "win32" && durable !== false) expect(directorySyncs, diagnostic).toBeLessThanOrEqual(4);
        else expect(directorySyncs, diagnostic).toBe(durable === false ? 0 : 4);
        // Baseline JS-visible fs calls for this 20-file/3-directory fixture, plus 20%.
        const baseline = backend === "auto" ? (kind === "tar" ? 2535 : 2544) : kind === "tar" ? 4132 : 4348;
        expect(observed.total() / 20, diagnostic).toBeLessThanOrEqual(Math.ceil(baseline * 1.2) / 20);
        vi.restoreAllMocks();
        for (let f = 0; f < 20; f++) expect(await fs.readFile(path.join(destDir, `d${f % 3}/f${f}`), "utf8")).toBe("NEW");
      });
    }
  });
}
