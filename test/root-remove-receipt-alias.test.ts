import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

it.each([undefined, "follow-parents-within-root"] as const)(
  "recaptures an unvisited canonical ancestor after an allowed parent alias (%s)", async mutationSymlinks => {
    const directory = await tempRoot("fs-safe-remove-receipt-alias-");
    const ancestor = path.join(directory, "ancestor");
    const parent = path.join(ancestor, "parent");
    const target = path.join(parent, "target");
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(target, "value");
    await fs.symlink(ancestor, path.join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");
    configureFsSafeNative({ mode: "off" });
    const scoped = await root(directory);
    const canonicalize = realpathSync.native;
    const rootCanonicalizations: string[] = [];
    vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      if (String(candidate) === scoped.rootReal) rootCanonicalizations.push(String(candidate));
      return canonicalize(candidate);
    });

    await expect(scoped.remove("alias/parent/target", { mutationSymlinks: "reject" })).rejects.toMatchObject({ code: "symlink" });
    await scoped.remove("alias/parent/target", { mutationSymlinks });

    expect(rootCanonicalizations).toHaveLength(3);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.lstat(path.join(directory, "alias"))).isSymbolicLink()).toBe(true);
  },
);

it("preserves final unlink aliases and explicit final-symlink rejection", async () => {
  const directory = await tempRoot("fs-safe-remove-receipt-leaf-alias-");
  const parent = path.join(directory, "ancestor", "parent");
  const target = path.join(parent, "target");
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(target, "value");
  await fs.symlink(target, path.join(parent, "symlink"), "file");
  await fs.link(target, path.join(parent, "hardlink"));
  const scoped = await root(directory);
  await expect(scoped.remove("ancestor/parent/symlink", { mutationSymlinks: "follow-parents-within-root" }))
    .rejects.toMatchObject({ code: "symlink" });
  await scoped.remove("ancestor/parent/symlink");
  await scoped.remove("ancestor/parent/hardlink");
  expect(await fs.readFile(target, "utf8")).toBe("value");
  expect(await fs.readdir(parent)).toEqual(["target"]);
});

it.each([1, 2, 3])("checks the full canonical parent route at observation %s", async failAt => {
  const directory = await tempRoot("fs-safe-remove-receipt-canonical-");
  const parent = path.join(directory, "ancestor", "parent");
  const target = path.join(parent, "target");
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(target, "value");
  const scoped = await root(directory);
  const canonicalize = realpathSync.native;
  let observations = 0;
  vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
    if (String(candidate) === parent && ++observations === failAt) return path.join(directory, "different-parent");
    return canonicalize(candidate);
  });
  const unlink = vi.spyOn(fs, "unlink");

  await expect(scoped.remove("ancestor/parent/target", { force: true })).rejects.toMatchObject({ code: "path-mismatch" });

  expect(observations).toBe(failAt);
  expect(unlink).toHaveBeenCalledTimes(failAt === 3 ? 1 : 0);
  if (failAt < 3) expect(await fs.readFile(target, "utf8")).toBe("value");
});

it.each(["leaf", "parent", "intermediate"].flatMap(missing => [false, true].map(force => ({ missing, force }))))(
  "preserves a missing $missing result (force=$force)", async ({ missing, force }) => {
    const directory = await tempRoot("fs-safe-remove-receipt-missing-");
    const ancestor = path.join(directory, "ancestor");
    const parent = path.join(ancestor, "parent");
    if (missing === "leaf") await fs.mkdir(parent, { recursive: true });
    if (missing === "parent") await fs.mkdir(ancestor);
    const scoped = await root(directory);
    const unlink = vi.spyOn(fs, "unlink");
    const pending = scoped.remove("ancestor/parent/target", { force });
    if (force) await pending;
    else await expect(pending).rejects.toMatchObject({ code: "not-found" });
    expect(unlink).not.toHaveBeenCalled();
  },
);

it("rejects a lost retained prefix while tolerating a missing parent", async () => {
  const directory = await tempRoot("fs-safe-remove-receipt-missing-prefix-");
  const ancestor = path.join(directory, "ancestor");
  const parent = path.join(ancestor, "missing-parent");
  await fs.mkdir(ancestor);
  const scoped = await root(directory);
  const lstat = fsSync.lstatSync.bind(fsSync);
  let parentObservations = 0;
  let moved = false;
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    if (String(args[0]) === parent && ++parentObservations === 2) {
      fsSync.renameSync(ancestor, path.join(directory, "saved"));
      moved = true;
    }
    return lstat(...args);
  }) as typeof fsSync.lstatSync);

  await expect(scoped.remove("ancestor/missing-parent/target", { force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(moved).toBe(true);
});
