import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { acquireFileLock } from "../src/file-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const options = { payload: () => ({ owner: "parent-budget" }), timeoutMs: 1000 };
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

describe("sidecar parent preparation", () => {
  const acquire = (target: string) => acquireFileLock(target, options);

  it("does not dispatch mkdir for an existing directory", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("sidecar-parent-budget-");
    const mkdir = vi.spyOn(fsp, "mkdir");
    const held = await acquire(path.join(directory, "state"));
    try {
      expect(mkdir).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(held.lockPath, "utf8"))).toEqual({ owner: "parent-budget" });
    } finally { await held.release(); }
    expect(fs.existsSync(held.lockPath)).toBe(false);
  });

  it("still creates missing parents and rejects a non-directory parent", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("sidecar-parent-missing-");
    const held = await acquire(path.join(directory, "one", "two", "state"));
    await held.release();
    expect(fs.statSync(path.join(directory, "one", "two")).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(directory, "file"), "preserved");
    await expect(Promise.resolve().then(() => acquire(path.join(directory, "file", "state"))))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(path.join(directory, "file"), "utf8")).toBe("preserved");
  });

  it("retains mkdir behavior if the advisory parent inspection fails", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("sidecar-parent-observation-");
    const stat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === directory) throw Object.assign(new Error("inspection unavailable"), { code: "EIO" });
      return Reflect.apply(stat, fs, args);
    }) as typeof fs.statSync);
    const held = await acquire(path.join(directory, "state"));
    await held.release();
    expect(fs.existsSync(held.lockPath)).toBe(false);
  });

  it("continues to canonicalize an existing directory alias", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("sidecar-parent-alias-");
    const parent = path.join(directory, "parent");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(parent);
    fs.symlinkSync(parent, alias, process.platform === "win32" ? "junction" : "dir");
    const held = await acquire(path.join(alias, "state"));
    try { expect(held.normalizedTargetPath).toBe(path.join(fs.realpathSync.native(parent), "state")); }
    finally { await held.release(); }
  });
});
