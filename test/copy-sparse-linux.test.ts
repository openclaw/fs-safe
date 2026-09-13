import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree, probeTreeClone } from "../src/copy.js";
import { getNativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => configureFsSafeNative({ mode: "auto" }));

describe.skipIf(process.platform !== "linux")("Linux sparse byte copies", () => {
  it("copies sparse contents and metadata without allocating zero-filled ranges", async (context) => {
    configureFsSafeNative({ mode: "auto" });
    if (!getNativeBinding()) return context.skip("native binding unavailable");
    const directory = await tempRoot("fs-safe-sparse-tree-");
    if (probeTreeClone(directory)) return context.skip("requires a filesystem using byte-copy fallback");
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    const names = ["holes", "payload"];
    const expected = new Map<string, string>();
    for (const name of names) {
      const file = await fs.open(path.join(source, name), "wx", 0o640);
      try {
        await file.truncate(8 * 1024 * 1024 + 37);
        if (name === "payload") await file.write(Buffer.from("sparse ordinary contents"), 0, 24, 3 * 1024 * 1024 + 5);
        await file.utimes(1_600_000_000, 1_600_000_000);
      } finally {
        await file.close();
      }
      const stat = await fs.stat(path.join(source, name), { bigint: true });
      expect(stat.blocks * 512n).toBeLessThan(stat.size / 8n);
      expected.set(name, createHash("sha256").update(await fs.readFile(path.join(source, name))).digest("hex"));
    }

    await copyTree(source, destination, { clone: "auto", concurrency: 2 });

    for (const name of names) {
      const original = path.join(source, name);
      const copied = path.join(destination, name);
      const before = await fs.stat(original, { bigint: true });
      const after = await fs.stat(copied, { bigint: true });
      expect(after.size).toBe(before.size);
      expect(after.ino).not.toBe(before.ino);
      expect(after.mode).toBe(before.mode);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.blocks * 512n).toBeLessThan(after.size / 8n);
      expect(createHash("sha256").update(await fs.readFile(copied)).digest("hex")).toBe(expected.get(name));
      await fs.writeFile(copied, "independent edit");
      expect(createHash("sha256").update(await fs.readFile(original)).digest("hex")).toBe(expected.get(name));
    }
  });
});
