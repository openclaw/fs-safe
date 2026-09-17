import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { admitTempWorkspaceRoot, admitTempWorkspaceRootSync } from "../src/temp-workspace-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const directoryLink = process.platform === "win32" ? "junction" : "dir";
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} missing temp root canonical admission`, () => {
    async function admit(rootDir: string) {
      return variant === "async"
        ? await admitTempWorkspaceRoot(rootDir)
        : admitTempWorkspaceRootSync(rootDir);
    }

    function afterMkdir(target: string, after: () => void) {
      let triggered = false;
      const observe = (name: unknown) => {
        if (name === target && !triggered) {
          triggered = true;
          after();
        }
      };
      if (variant === "async") {
        const mkdir = fs.mkdir.bind(fs);
        return vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
          const result = await mkdir(...args);
          observe(args[0]);
          return result;
        });
      }
      const mkdir = fsSync.mkdirSync.bind(fsSync);
      return vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
        const result = mkdir(...args);
        observe(args[0]);
        return result;
      });
    }

    it("shares only the post-create parent canonical lookup with its direct child", async () => {
      const base = await tempRoot("fs-safe-temp-canonical-budget-");
      const first = path.join(base, "one");
      const second = path.join(first, "two");
      const target = path.join(second, "three");
      const canonical = vi.spyOn(realpathSync, "native");
      expect((await admit(target)).dir).toBe(target);
      expect(canonical.mock.calls.map(([name]) => name)).toEqual([
        base, base,
        base, first,
        first, second,
        second, target,
      ]);
    });

    it("preserves caller-approved ancestry aliases and actual canonical spelling", async () => {
      const base = await tempRoot("fs-safe-temp-canonical-alias-");
      const real = path.join(base, "Real");
      const alias = path.join(base, "alias");
      await fs.mkdir(real, { mode: 0o700 });
      await fs.symlink(real, alias, directoryLink);
      const target = path.join(alias, "caf\u00e9", "Child");
      const admitted = await admit(target);
      const expected = realpathSync.native(path.join(real, "caf\u00e9", "Child"));
      expect(admitted.realPath).toBe(expected);
      expect(() => admitted.assertCurrent()).not.toThrow();
      expect(() => admitted.assertAncestry()).not.toThrow();
    });

    it("keeps parent-first failures when canonical spelling differs", async () => {
      const base = await tempRoot("fs-safe-temp-canonical-spelling-");
      const first = path.join(base, "parent");
      const canonicalFirst = path.join(base, "PARENT");
      const target = path.join(first, "child");
      const parentFailure = Object.assign(new Error("aliased parent resolution denied"), { code: "EACCES" });
      let createdTarget = false;
      let childCanonicalizations = 0;
      const canonicalize = realpathSync.native.bind(realpathSync);
      // Model a filesystem canonical spelling that differs from the admitted name.
      vi.spyOn(realpathSync, "native").mockImplementation((name) => {
        if (createdTarget && name === first) throw parentFailure;
        const actual = canonicalize(name);
        if (name === first) return canonicalFirst;
        if (name === target) {
          if (createdTarget) childCanonicalizations += 1;
          return path.join(canonicalFirst, "child");
        }
        return actual;
      });
      afterMkdir(target, () => { createdTarget = true; });
      await expect(admit(target)).rejects.toBe(parentFailure);
      expect(childCanonicalizations).toBe(0);
    });

    it("rejects a replaced parent before canonicalizing or inspecting its child", async () => {
      const base = await tempRoot("fs-safe-temp-canonical-parent-identity-");
      const parent = path.join(base, "parent");
      const saved = path.join(base, "saved");
      const target = path.join(parent, "child");
      await fs.mkdir(parent, { mode: 0o700 });
      let created = false;
      const lstat = fsSync.lstatSync.bind(fsSync);
      const canonicalize = realpathSync.native.bind(realpathSync);
      let childStats = 0;
      let childCanonicalizations = 0;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        if (created && name === target) childStats += 1;
        return lstat(name, options);
      });
      vi.spyOn(realpathSync, "native").mockImplementation((name) => {
        if (created && name === target) childCanonicalizations += 1;
        return canonicalize(name);
      });
      afterMkdir(target, () => {
        created = true;
        fsSync.renameSync(parent, saved);
        fsSync.mkdirSync(parent, { mode: 0o700 });
        fsSync.mkdirSync(target, { mode: 0o700 });
      });
      await expect(admit(target)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(childStats).toBe(0);
      expect(childCanonicalizations).toBe(0);
      expect(lstat(path.join(saved, "child")).isDirectory()).toBe(true);
      expect(lstat(target).isDirectory()).toBe(true);
    });

    it.each([false, true])(
      "rejects canonical parent drift with the same parent identity (child missing: %s)",
      async (childMissing) => {
        const base = await tempRoot("fs-safe-temp-canonical-parent-name-");
        const ancestor = path.join(base, "ancestor");
        const relocated = path.join(base, "relocated");
        const parent = path.join(ancestor, "parent");
        const target = path.join(parent, "child");
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        const lstat = fsSync.lstatSync.bind(fsSync);
        const expected = lstat(parent, { bigint: true });
        let created = false;
        let sameParentIdentity = false;
        let childStats = 0;
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          if (created && name === target) childStats += 1;
          return lstat(name, options);
        });
        afterMkdir(target, () => {
          created = true;
          fsSync.renameSync(ancestor, relocated);
          fsSync.symlinkSync(relocated, ancestor, directoryLink);
          const current = lstat(parent, { bigint: true });
          sameParentIdentity = current.dev === expected.dev && current.ino === expected.ino;
          if (childMissing) fsSync.rmdirSync(path.join(relocated, "parent", "child"));
        });
        await expect(admit(target)).rejects.toMatchObject({ code: "path-mismatch" });
        expect(sameParentIdentity).toBe(true);
        expect(childStats).toBe(0);
        if (childMissing) {
          expect(() => lstat(path.join(relocated, "parent", "child")))
            .toThrowError(expect.objectContaining({ code: "ENOENT" }));
        } else expect(lstat(path.join(relocated, "parent", "child")).isDirectory()).toBe(true);
      },
    );

    it("rechecks the next parent before creating another missing component", async () => {
      const base = await tempRoot("fs-safe-temp-canonical-next-parent-");
      const ancestor = path.join(base, "ancestor");
      const relocated = path.join(base, "relocated");
      const first = path.join(ancestor, "first");
      const target = path.join(first, "second");
      await fs.mkdir(ancestor, { mode: 0o700 });
      let created = false;
      let replaced = false;
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (created && !replaced && name === first) {
          replaced = true;
          fsSync.renameSync(ancestor, relocated);
          fsSync.symlinkSync(relocated, ancestor, directoryLink);
        }
        return stat;
      });
      const mkdir = afterMkdir(first, () => { created = true; });
      await expect(admit(target)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(replaced).toBe(true);
      expect(mkdir.mock.calls.map(([name]) => name)).toEqual([first]);
      expect(lstat(path.join(relocated, "first")).isDirectory()).toBe(true);
      expect(() => lstat(path.join(relocated, "first", "second")))
        .toThrowError(expect.objectContaining({ code: "ENOENT" }));
    });

    it("discards a differing child canonical result before a successful fallback", async () => {
      const base = await tempRoot("fs-safe-temp-canonical-refresh-");
      const target = path.join(base, "child");
      const saved = path.join(base, "saved");
      const outside = path.join(base, "other", "child");
      await fs.mkdir(outside, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(outside, "keep"), "untouched");
      let created = false;
      let childCanonicalizations = 0;
      let originalIdentity: { dev: bigint; ino: bigint } | undefined;
      const canonicalize = realpathSync.native.bind(realpathSync);
      vi.spyOn(realpathSync, "native").mockImplementation((name) => {
        const result = canonicalize(name);
        if (created && name === target && ++childCanonicalizations === 1) {
          fsSync.rmSync(target, { recursive: true, force: true });
          fsSync.renameSync(saved, target);
        }
        return result;
      });
      afterMkdir(target, () => {
        const stat = fsSync.lstatSync(target, { bigint: true });
        originalIdentity = { dev: stat.dev, ino: stat.ino };
        fsSync.renameSync(target, saved);
        fsSync.symlinkSync(outside, target, directoryLink);
        created = true;
      });
      const admitted = await admit(target);
      expect(childCanonicalizations).toBe(2);
      expect(admitted.realPath).toBe(target);
      expect(admitted.identity).toEqual(originalIdentity);
      expect(() => admitted.assertCurrent()).not.toThrow();
      expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("untouched");
    });

    it("still rejects a child symlink installed after its canonical lookup", async () => {
      const base = await tempRoot("fs-safe-temp-canonical-child-swap-");
      const target = path.join(base, "child");
      const saved = path.join(base, "saved");
      const outside = path.join(base, "outside");
      await fs.mkdir(outside, { mode: 0o700 });
      await fs.writeFile(path.join(outside, "keep"), "untouched");
      let created = false;
      let replaced = false;
      const canonicalize = realpathSync.native.bind(realpathSync);
      vi.spyOn(realpathSync, "native").mockImplementation((name) => {
        const result = canonicalize(name);
        if (created && !replaced && name === target) {
          replaced = true;
          fsSync.renameSync(target, saved);
          fsSync.symlinkSync(outside, target, directoryLink);
        }
        return result;
      });
      afterMkdir(target, () => { created = true; });
      const chmod = vi.spyOn(fsSync, "fchmod");
      const chmodSync = vi.spyOn(fsSync, "fchmodSync");
      await expect(admit(target)).rejects.toMatchObject({ code: "not-file" });
      expect(replaced).toBe(true);
      expect(chmod).not.toHaveBeenCalled();
      expect(chmodSync).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("untouched");
    });

    it.each([false, true])(
      "preserves parent-before-child canonical error priority (parent failure: %s)",
      async (failParent) => {
        const base = await tempRoot("fs-safe-temp-canonical-error-order-");
        const target = path.join(base, "child");
        const parentFailure = Object.assign(new Error("parent resolution denied"), { code: "EACCES" });
        const childFailure = Object.assign(new Error("child disappeared"), { code: "ENOENT" });
        let created = false;
        let childStats = 0;
        const canonicalize = realpathSync.native.bind(realpathSync);
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(realpathSync, "native").mockImplementation((name) => {
          if (created && name === base && failParent) throw parentFailure;
          if (created && name === target) throw childFailure;
          return canonicalize(name);
        });
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          if (created && name === target) childStats += 1;
          return lstat(name, options);
        });
        afterMkdir(target, () => { created = true; });
        await expect(admit(target)).rejects.toBe(failParent ? parentFailure : childFailure);
        expect(childStats).toBe(0);
        expect(lstat(target).isDirectory()).toBe(true);
      },
    );
  });
}
