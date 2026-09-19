import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractArchive } from "../src/archive.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { modeArchive } from "./helpers/archive-modes.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { observeArchiveFs } from "./helpers/archive-fs-counts.js";
import { useSuiteFixture } from "./helpers/suite-fixture.js";

const extractionTimeoutMs = 30_000;
const fixtureTimeoutMs = extractionTimeoutMs + 10_000;
const durableModes = [undefined, false, true] as const;
// macOS measurements for the 20-file/3-directory fixture; durable:true then false/default.
// Include every fs/promises call and async FileHandle method, including own close.
// Final mkdir parent fences add 23 native or 66 portable lstat/realpath pairs.
const budgets = {
  auto: { tar: { async: [268, 196], total: [3177, 2546] }, zip: { async: [268, 196], total: [3186, 2556] } },
  off: { tar: { async: [455, 383], total: [4280, 3649] }, zip: { async: [530, 458], total: [4834, 4204] } },
} as const;

for (const backend of ["auto", "off"] as const) {
  describe.skipIf(backend === "auto" && !paxNative)(`archive sync budget: native ${backend}`, () => {
    for (const kind of ["tar", "zip"] as const) {
      describe(kind, () => {
        const directories: string[] = [];
        const run = useSuiteFixture(async () => {
          const archive = await modeArchive(kind, [
            ...Array.from({ length: 3 }, (_, d) => ({ path: `d${d}/`, directory: true, mode: 0o755 })),
            ...Array.from({ length: 20 }, (_, f) => ({ path: `d${f % 3}/f${f}`, mode: 0o644 })),
          ]);
          const fixtures = new Map<boolean | undefined, { base: string; destDir: string; archivePath: string }>();
          for (const durable of durableModes) {
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-fsync-budget-"));
            directories.push(directory);
            const base = await fs.realpath(directory);
            const destDir = path.join(base, "output");
            await fs.mkdir(destDir);
            const archivePath = path.join(base, `input.${kind}`);
            await fs.writeFile(archivePath, archive);
            fixtures.set(durable, { base, destDir, archivePath });
          }
          return fixtures;
        }, async () => {
          await Promise.all(directories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
        }, fixtureTimeoutMs);

        it.each(durableModes)("durable %s", (durable) => run(async (fixtures) => {
          try {
            if (paxNative) __setNativeLoaderForTest(() => paxNative);
            configureFsSafeNative({ mode: backend });
            const { base, destDir, archivePath } = fixtures.get(durable)!;
            const observed = await observeArchiveFs(base);
            await extractArchive({ archivePath, destDir, kind, timeoutMs: extractionTimeoutMs, durable });
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
          } finally {
            // Vitest timeouts must not restore spies while extraction is active.
            vi.restoreAllMocks();
            configureFsSafeNative({ mode: "auto" });
            __resetNativeLoaderForTest();
          }
        }), fixtureTimeoutMs);
      });
    }
  });
}
