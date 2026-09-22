import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  readSecretFile,
  readSecretFileSync,
  tryReadSecretFile,
  tryReadSecretFileSync,
  type SecretFileReadOptions,
} from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let filePath: string;
beforeEach(async () => {
  filePath = path.join(await tempRoot("fs-safe-secret-errors-"), "token");
  await fs.writeFile(filePath, "synthetic-secret\n", { mode: 0o600 });
});

const readers = { readSecretFile, readSecretFileSync, tryReadSecretFile, tryReadSecretFileSync };
for (const [name, read] of Object.entries(readers)) {
  describe(name, () => {
    it("reads a synthetic credential", async () => {
      expect(await read(filePath, "token")).toBe("synthetic-secret");
    });

    it.each([null, undefined, "synthetic failure", 0, false])(
      "normalizes an inspection getter throwing %s",
      async (failure) => {
        let reads = 0;
        const options: SecretFileReadOptions = {
          get rejectSymlink(): boolean {
            reads++;
            throw failure;
          },
        };
        let caught: unknown;
        try { await read(filePath, "token", options); }
        catch (error) { caught = error; }

        expect(reads).toBe(1);
        expect(caught).toBeInstanceOf(FsSafeError);
        expect(caught).toMatchObject({
          code: "invalid-path",
          category: "policy",
          message: `Failed to inspect token file at ${filePath}: Error: ${String(failure)}`,
          cause: new Error(String(failure)),
        });
      },
    );
  });
}
