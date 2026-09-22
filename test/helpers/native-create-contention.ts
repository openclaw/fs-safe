import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../../src/native-config.js";
import { __setNativeLoaderForTest, type NativeBinding } from "../../src/native.js";
import { runOwnedPinnedWrite } from "../../src/pinned-write.js";
import { useSuiteFixture } from "./suite-fixture.js";

export function registerNativeCreateContentionTests(
  native: NativeBinding,
  setCleanupOwnership: (owned: boolean) => void,
  resetNativeTestState: () => void,
): void {
  describe.each(["off", "require"] as const)("concurrent create-only writes in %s mode", (mode) => {
    let directory: string | undefined;
    const run = useSuiteFixture(async () => {
      setCleanupOwnership(true);
      directory = await fs.mkdtemp(path.join(os.tmpdir(), `fs-safe-${mode}-write-race-`));
      return directory;
    }, async () => {
      try {
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      } finally {
        setCleanupOwnership(false);
        resetNativeTestState();
      }
    });

    it("allows exactly one of many concurrent create-only writes", () => run(async (directory) => {
      if (mode === "require") __setNativeLoaderForTest(() => native);
      configureFsSafeNative({ mode });
      const attempts = Array.from({ length: 32 }, (_, index) =>
        runOwnedPinnedWrite({
          rootPath: directory,
          relativeParentPath: "",
          basename: "winner",
          mkdir: false,
          mode: 0o600,
          overwrite: false,
          input: { kind: "buffer", data: String(index) },
        }),
      );

      const results = await Promise.allSettled(attempts);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(31);
      expect(Number(await fs.readFile(path.join(directory, "winner"), "utf8"))).toSatisfy(
        (value: number) => Number.isInteger(value) && value >= 0 && value < attempts.length,
      );
    }), 15_000);
  });
}
