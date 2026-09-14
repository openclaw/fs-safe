import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeExternalFileWithinRoot } from "../src/output.js";
import { writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe.each(["external", "sibling"] as const)("raw filename budget through %s output", kind => {
  it.each(["K".repeat(80), "\u037e".repeat(120)])("stages a valid name whose normalization is shorter: %s", async stem => {
    const dir = await tempRoot("fs-safe-raw-name-");
    const name = `${stem}.txt`, targetPath = path.join(dir, name);
    expect(Buffer.byteLength(name)).toBe(244);
    let calls = 0;
    const write = async (filePath: string) => {
      calls++;
      const component = path.basename(filePath);
      expect(Buffer.byteLength(component)).toBeLessThanOrEqual(255);
      expect(Buffer.byteLength(component.normalize("NFC"))).toBeLessThanOrEqual(255);
      expect(Buffer.byteLength(component.normalize("NFD"))).toBeLessThanOrEqual(255);
      await fs.writeFile(filePath, "complete", { mode: 0o600 });
    };
    if (kind === "external") await writeExternalFileWithinRoot({ rootDir: dir, path: name, staging: "sibling", write });
    else await writeViaSiblingTempPath({ rootDir: dir, targetPath, writeTemp: write });
    expect(calls).toBe(1);
    expect(await fs.readFile(targetPath, "utf8")).toBe("complete");
    expect(await fs.readdir(dir)).toHaveLength(1);
  });
});
