import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native lanes build the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); __resetNativeLoaderForTest(); });

describe.runIf(native?.openCreateBeneath)("native existing-file writable opens", () => {
  it.skipIf(Boolean(process.versions.bun)).each(["append", "openWritable"])("pins %s async resource counts", operation => {
    expect(() => execFileSync(process.execPath, ["scripts/native-call-budget-proof.mjs", "--resources-only", "--operation", operation], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe",
    })).not.toThrow();
  });

  it("does not attempt parent creation for an existing append target", async () => {
    const directory = await tempRoot("fs-safe-existing-append-");
    await fs.writeFile(path.join(directory, "value"), "first");
    const openParent = vi.fn(() => { throw new Error("unneeded parent admission"); });
    __setNativeLoaderForTest(() => ({ ...native!, openBeneath: openParent }));
    configureFsSafeNative({ mode: "require" });
    const scoped = await root(directory);
    await scoped.append("value", "second", { durable: false });
    expect(openParent).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, "value"), "utf8")).toBe("firstsecond");
  });

  it("keeps required creation capability admission for an existing target", async () => {
    const directory = await tempRoot("fs-safe-existing-required-");
    await fs.writeFile(path.join(directory, "value"), "preserve");
    __setNativeLoaderForTest(() => ({ ...native!, mkdirChildBeneath: undefined }));
    configureFsSafeNative({ mode: "require" });
    const scoped = await root(directory);
    await expect(scoped.append("value", "unexpected", { durable: false }))
      .rejects.toMatchObject({ code: "helper-unavailable" });
    expect(await fs.readFile(path.join(directory, "value"), "utf8")).toBe("preserve");
  });
});
