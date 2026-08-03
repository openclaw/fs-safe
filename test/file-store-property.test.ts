import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { useRealTempDirs } from "./helpers/vitest.js";
import {
  adversarialPath,
  aliasingPathPair,
  propertyParameters,
} from "./helpers/property.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { isPathInside } from "../src/path.js";

const { tempRoot } = useRealTempDirs();

type ValidationResult =
  | { accepted: true; path: string }
  | { accepted: false; code: unknown };

function validatePath(operation: () => string): ValidationResult {
  try {
    return { accepted: true, path: operation() };
  } catch (error) {
    return { accepted: false, code: (error as { code?: unknown }).code };
  }
}

function portableKey(key: string): string {
  return path.posix.normalize(key).normalize("NFC").replace(/[ .]+(?=\/|$)/gu, "");
}

async function entriesIfPresent(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("FileStore path properties", () => {
  it("keeps every accepted key canonical, strictly contained, and sync-equivalent", async () => {
    const base = await tempRoot("fs-safe-store-property-");
    const rootDir = path.join(base, "root");
    const asyncStore = fileStore({ rootDir });
    const syncStore = fileStoreSync({ rootDir });

    await fc.assert(
      fc.asyncProperty(adversarialPath, async (key) => {
        const asyncResult = validatePath(() => asyncStore.path(key));
        const syncResult = validatePath(() => syncStore.path(key));
        expect(syncResult, JSON.stringify({ key })).toEqual(asyncResult);

        if (asyncResult.accepted) {
          expect(asyncResult.path, JSON.stringify({ key })).not.toBe(rootDir);
          expect(isPathInside(rootDir, asyncResult.path), JSON.stringify({ key })).toBe(true);
          expect(key, JSON.stringify({ key })).toBe(portableKey(key));
          return;
        }

        expect(asyncResult.code, JSON.stringify({ key })).toBe("invalid-path");
        const before = await entriesIfPresent(rootDir);
        await expect(asyncStore.write(key, "async"), JSON.stringify({ key })).rejects.toMatchObject({
          code: "invalid-path",
        });
        expect(() => syncStore.write(key, "sync"), JSON.stringify({ key })).toThrow(
          expect.objectContaining({ code: "invalid-path" }),
        );
        expect(await entriesIfPresent(rootDir), JSON.stringify({ key })).toEqual(before);
      }),
      propertyParameters(250),
    );
  });

  it("never accepts two portable-equivalent spellings for one output path", async () => {
    const base = await tempRoot("fs-safe-store-alias-property-");
    const store = fileStore({ rootDir: path.join(base, "root") });

    await fc.assert(
      fc.asyncProperty(aliasingPathPair, async ([first, second]) => {
        expect(portableKey(first), JSON.stringify({ first, second })).toBe(portableKey(second));
        const firstResult = validatePath(() => store.path(first));
        const secondResult = validatePath(() => store.path(second));
        expect(
          firstResult.accepted && secondResult.accepted,
          JSON.stringify({ first, second }),
        ).toBe(false);
      }),
      propertyParameters(150),
    );
  });
});
