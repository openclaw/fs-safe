import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { readRegularFile, readRegularFileSync } from "../src/regular-file.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

describe("regular-file overflow compatibility", () => {
  it("preserves the pre-0.4.2 async overflow message with a structured code", async () => {
    const root = await tempRoot("fs-safe-regular-compat-");
    const filePath = path.join(root, "input.txt");
    await fs.writeFile(filePath, "abc", "utf8");

    await expect(readRegularFile({ filePath, maxBytes: 2 })).rejects.toMatchObject({
      code: "too-large",
      message: `File exceeds 2 bytes: ${filePath}`,
      constructor: FsSafeError,
    });
  });

  it("preserves the pre-0.4.2 sync overflow message with a structured code", async () => {
    const root = await tempRoot("fs-safe-regular-compat-");
    const filePath = path.join(root, "input.txt");
    await fs.writeFile(filePath, "abc", "utf8");

    expect(() => readRegularFileSync({ filePath, maxBytes: 2 })).toThrow(
      expect.objectContaining({
        code: "too-large",
        message: `File exceeds 2 bytes: ${filePath}`,
        constructor: FsSafeError,
      }),
    );
  });
});
