import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { metadataPromiseOverhead } from "../scripts/native-call-budget-resources.mjs";
import { configureFsSafeNative } from "../src/config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("bounds mkdir metadata promises without adding filesystem hops", async () => {
  const { AsyncLocalStorage, createHook } = await import("node:async_hooks");
  const context = new AsyncLocalStorage<Record<string, number>>();
  const { createDirectorySync } = await import("../src/create.js");
  const directory = await tempRoot("fs-safe-mkdir-budget-");
  for (const mode of ["off"] as const) {
    configureFsSafeNative({ mode });
    const safe = await root(directory);
    const cases: Array<[string, () => unknown, () => void]> = [
      ["mkdir", () => safe.mkdir("child"), () => fsSync.rmdirSync(path.join(directory, "child"))],
      ["mkdir-recursive", () => safe.mkdir("a/b/c"), () => fsSync.rmSync(path.join(directory, "a"), { recursive: true })],
      ["ensureRoot", () => safe.ensureRoot(), () => {}],
      ["mkdir-sync", () => createDirectorySync(path.join(directory, "sync")), () => fsSync.rmdirSync(path.join(directory, "sync"))],
    ];
    // Two async traversal observations add 16 promises; ensureRoot has one (+7).
    const promises: Record<string, number> = { mkdir: 21 + 16, "mkdir-recursive": 21 + 16, ensureRoot: 21 + 7, "mkdir-sync": 2 };
    const asyncMetadata: Record<string, number> = { mkdir: 2, "mkdir-recursive": 2, ensureRoot: 1, "mkdir-sync": 0 };
    for (const [name, operation, cleanup] of cases) {
      await operation(); cleanup();
      const counts: Record<string, number> = {};
      const hook = createHook({ init(_id, type) {
        if (context.getStore() === counts) counts[type] = (counts[type] ?? 0) + 1;
      } });
      hook.enable();
      try { await context.run(counts, operation); } finally { hook.disable(); }
      cleanup();
      expect(counts.PROMISE ?? 0, `${mode}/${name}`).toBeLessThanOrEqual(promises[name]! + metadataPromiseOverhead(asyncMetadata[name]!));
      expect(counts.FSREQPROMISE ?? 0, `${mode}/${name}`).toBe(asyncMetadata[name]);
    }
  }
  configureFsSafeNative({ mode: "auto" });
});
