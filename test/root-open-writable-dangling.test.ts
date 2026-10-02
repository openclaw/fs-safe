import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { allowWindowsFilesystemStalls, useRealTempDirs } from "./helpers/vitest.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink.js";

allowWindowsFilesystemStalls();
const { tempRoot } = useRealTempDirs();
afterEach(() => configureFsSafeNative({ mode: "auto" }));

describe.each(["auto", "off"] as const)("dangling writable leaf (native %s)", mode => {
  describe.each(["inside", "absolute outside", "relative outside", ...(process.platform === "win32" ? ["UNC outside", "device outside"] : [])])("%s", kind => {
  it.each(["replace", "append", "update", "root.append"] as const)(
    "%s rejects a dangling leaf without creating its referent", async (operation, context) => {
      configureFsSafeNative({ mode });
      const base = await tempRoot("fs-safe-writable-dangling-");
      const directory = path.join(base, "root", "nested");
      await fs.mkdir(directory, { recursive: true });
      const capability = await root(path.join(base, "root"));
      const leaf = path.join(directory, "leaf");
      const target = path.join(kind === "inside" ? directory : base, "missing");
      const linkTarget = kind === "relative outside" ? path.join("..", "..", "missing")
        : kind === "UNC outside" ? `\\\\localhost\\${target[0]}$${target.slice(2)}`
        : kind === "device outside" ? `\\\\?\\${target}` : target;
      const observedLink = await fileSymlinkOrSkip(linkTarget, leaf, context);
      const failure = operation === "root.append"
        ? capability.append("nested/leaf", "data")
        : capability.openWritable("nested/leaf", { writeMode: operation });
      await expect(failure).rejects.toBeDefined();
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(leaf)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(leaf)).toBe(observedLink);
    },
  );
  });

  it("still creates regular leaves and follows existing contained leaves with omitted policy", async context => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-writable-existing-");
    const capability = await root(directory);
    const created = await capability.openWritable("target", { writeMode: "update" });
    try { await created.handle.writeFile("original"); } finally { await created.handle.close(); }
    await fileSymlinkOrSkip(path.join(directory, "target"), path.join(directory, "leaf"), context);
    const opened = await capability.openWritable("leaf", { writeMode: "append" });
    try { await opened.handle.writeFile(" appended"); } finally { await opened.handle.close(); }
    expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("original appended");
    expect((await fs.lstat(path.join(directory, "leaf"))).isSymbolicLink()).toBe(true);
  });
});
