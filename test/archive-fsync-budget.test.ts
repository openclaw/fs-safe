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
// macOS measurements for the 20-file/3-directory fixture; durable:true then false/default.
// Include every fs/promises call and async FileHandle method, including own close.
const budgets = {
  auto: { tar: { async: [268, 196], total: [3131, 2500] }, zip: { async: [268, 196], total: [3140, 2510] } },
  off: { tar: { async: [455, 383], total: [4148, 3517] }, zip: { async: [530, 458], total: [4702, 4072] } },
} as const;
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

for (const backend of ["auto", "off"] as const) {
  describe.skipIf(backend === "auto" && !paxNative)(`archive sync budget: native ${backend}`, () => {
    for (const kind of ["tar", "zip"] as const) {
      it.each([undefined, false, true])(`${kind}: durable %s`, async (durable) => {
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
        expect(observed.syncs.filter((type) => type === "file").length, diagnostic).toBe(durable === true ? 20 : 0);
        const directorySyncs = observed.syncs.filter((type) => type === "directory").length;
        if (process.platform === "win32" && durable === true) expect(directorySyncs, diagnostic).toBeLessThanOrEqual(4);
        else expect(directorySyncs, diagnostic).toBe(durable === true ? 4 : 0);
        const budget = budgets[backend][kind];
        const index = durable === true ? 0 : 1;
        expect(observed.asyncTotal(), diagnostic).toBeLessThanOrEqual(Math.ceil(budget.async[index] * 1.1));
        expect(observed.total(), diagnostic).toBeLessThanOrEqual(Math.ceil(budget.total[index] * 1.1));
        for (const name of ["p.lstat", "p.stat", "p.realpath", "h.stat"]) {
          expect(observed.counts[name] ?? 0, diagnostic).toBe(0);
        }
        vi.restoreAllMocks();
        for (let f = 0; f < 20; f++) expect(await fs.readFile(path.join(destDir, `d${f % 3}/f${f}`), "utf8")).toBe("NEW");
      });
    }
  });
}
