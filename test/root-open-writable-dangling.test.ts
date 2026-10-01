import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => configureFsSafeNative({ mode: "auto" }));

describe.each(["auto", "off"] as const)("dangling writable leaf (native %s)", mode => {
  it.each(["replace", "append", "update", "root.append"] as const)(
    "%s rejects a dangling leaf without creating its referent", async operation => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-writable-dangling-");
      const capability = await root(directory);
      const leaf = path.join(directory, "leaf");
      const target = path.join(directory, "missing");
      await fs.symlink(target, leaf, "file");
      const failure = operation === "root.append"
        ? capability.append("leaf", "data")
        : capability.openWritable("leaf", { writeMode: operation });
      await expect(failure).rejects.toBeDefined();
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(leaf)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(leaf)).toBe(target);
    },
  );

  it("still creates regular leaves and follows existing contained leaves with omitted policy", async () => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-writable-existing-");
    const capability = await root(directory);
    const created = await capability.openWritable("target", { writeMode: "update" });
    try { await created.handle.writeFile("original"); } finally { await created.handle.close(); }
    await fs.symlink(path.join(directory, "target"), path.join(directory, "leaf"), "file");
    const opened = await capability.openWritable("leaf", { writeMode: "append" });
    try { await opened.handle.writeFile(" appended"); } finally { await opened.handle.close(); }
    expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original appended");
    expect((await fs.lstat(path.join(directory, "leaf"))).isSymbolicLink()).toBe(true);
  });
});
