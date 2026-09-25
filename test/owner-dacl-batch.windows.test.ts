import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { itWin32, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

itWin32("inspects Unicode paths through each configured batch backend", async () => {
  // The public package owns the isolated JS worker and its colocated command assets.
  // Build first, as for package acceptance, to exercise their shipped locations.
  const { readOwnerAndDacl, readOwnerAndDaclBatch } = await import("../dist/permissions-public.js");
  const { configureFsSafeNative, getFsSafeNativeConfig } = await import("../dist/config.js");
  const previous = getFsSafeNativeConfig();
  // Ordinary CI has no addon; required-native CI also proves backend equivalence.
  const modes = previous.mode === "require" ? ["require", "off"] as const : ["off"] as const;
  const directory = await tempRoot("fs-safe-owner-dacl-batch-");
  const child = path.join(directory, "é-🦀");
  await fs.mkdir(child);
  const paths = [child, directory, child];
  try {
    configureFsSafeNative({ mode: modes[0] });
    const expected = paths.map(readOwnerAndDacl);
    for (const mode of modes) {
      configureFsSafeNative({ mode });
      const facts = await readOwnerAndDaclBatch(paths, { timeoutMs: 60_000 });
      expect(facts).toEqual(expected);
      await expect(readOwnerAndDaclBatch([child, path.join(directory, "missing")], { timeoutMs: 60_000 }))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    configureFsSafeNative(previous);
  }
}, 260_000);
