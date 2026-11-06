import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  tempWorkspace, tempWorkspaceSync, withTempWorkspace, withTempWorkspaceSync,
  type TempWorkspaceOptions,
} from "../src/temp.js";
import { useWorkspaceFixture } from "./helpers/temp-workspace.js";

const { tempRoot } = useWorkspaceFixture();

for (const variant of ["async", "sync"] as const) {
  describe.skipIf(process.platform === "win32")(`${variant} trusted writable ancestors`, () => {
    async function fixture() {
      const ancestor = await tempRoot("fs-safe-trusted-ancestor-");
      const rootDir = path.join(ancestor, "private");
      await fs.mkdir(rootDir, { mode: 0o700 });
      await fs.chmod(ancestor, 0o777);
      return { ancestor, rootDir };
    }

    async function create(rootDir: string, trustedWritableAncestors?: readonly string[],
      options: Partial<TempWorkspaceOptions> = {}) {
      const params = { rootDir, prefix: "workspace-", trustedWritableAncestors, ...options };
      return variant === "async" ? await tempWorkspace(params) : tempWorkspaceSync(params);
    }

    it("keeps omitted, empty, and nonmatching policies strict", async () => {
      const { ancestor, rootDir } = await fixture();
      for (const policy of [undefined, [], [path.dirname(ancestor)]]) {
        await expect(create(rootDir, policy)).rejects.toMatchObject({ code: "insecure-permissions" });
      }
      expect(await fs.readdir(rootDir)).toEqual([]);
    });

    it.each([0o770, 0o777])("admits only the named ancestor at mode %o", async (mode) => {
      const { ancestor, rootDir } = await fixture();
      await fs.chmod(ancestor, mode);
      // Exercise the native creation route too when the test host has built it.
      configureFsSafeNative({ mode: "auto" });
      const policy = [ancestor];
      const workspace = await create(rootDir, policy);
      policy.length = 0;
      await workspace.writeText("result", "private");
      expect((await workspace.read("result")).toString()).toBe("private");
      expect(fsSync.statSync(ancestor).mode & 0o777).toBe(mode);
      expect(fsSync.statSync(rootDir).mode & 0o777).toBe(0o700);
      expect(fsSync.statSync(workspace.dir).mode & 0o777).toBe(0o700);
      expect(await workspace.cleanup()).toBe("removed");
    });

    it.each(["missing", "alias"] as const)("admits a %s root through the same policy", async (kind) => {
      const { ancestor, rootDir } = await fixture();
      const selected = path.join(ancestor, kind, "nested");
      if (kind === "alias") {
        await fs.mkdir(path.join(rootDir, "nested"), { mode: 0o700 });
        await fs.symlink(rootDir, path.dirname(selected), "dir");
      }
      const options = { rootDir: selected, prefix: "scope-", trustedWritableAncestors: [ancestor] };
      let created = "";
      if (variant === "async") {
        await withTempWorkspace(options, async (workspace) => {
          created = workspace.dir;
          await workspace.writeText("result", "scoped");
          expect((await workspace.read("result")).toString()).toBe("scoped");
        });
      } else {
        withTempWorkspaceSync(options, (workspace) => {
          created = workspace.dir;
          workspace.writeText("result", "scoped");
          expect(workspace.read("result").toString()).toBe("scoped");
        });
      }
      expect(fsSync.existsSync(created)).toBe(false);
      expect(fsSync.statSync(selected).mode & 0o777).toBe(0o700);
    });

    it("does not grant trust recursively to a writable descendant", async () => {
      const { ancestor, rootDir } = await fixture();
      const nestedRoot = path.join(rootDir, "nested");
      await fs.mkdir(nestedRoot, { mode: 0o700 });
      await fs.chmod(rootDir, 0o777);
      await expect(create(nestedRoot, [ancestor])).rejects.toMatchObject({ code: "insecure-permissions" });
      expect(await fs.readdir(nestedRoot)).toEqual([]);
    });

    it.each([0o777, 0o1777])("keeps a listed private root strict at mode %o", async (mode) => {
      const { ancestor, rootDir } = await fixture();
      await fs.chmod(rootDir, mode);
      await expect(create(rootDir, [ancestor, rootDir])).rejects.toMatchObject({ code: "insecure-permissions" });
      expect(await fs.readdir(rootDir)).toEqual([]);
    });

    it("rejects a writable child mode even below a trusted ancestor", async () => {
      const { ancestor, rootDir } = await fixture();
      await expect(create(rootDir, [ancestor], { dirMode: 0o770 }))
        .rejects.toMatchObject({ code: "insecure-permissions" });
      expect(await fs.readdir(rootDir)).toEqual([]);
    });

    it.each(["ancestor", "rootDir"] as const)("still rejects a foreign-owned %s", async (kind) => {
      const paths = await fixture();
      const lstat = fsSync.lstatSync.bind(fsSync);
      // Simulate an OS ownership observation without requiring privileged chown.
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (name === paths[kind] && typeof stat?.uid === "bigint") {
          stat.uid = BigInt(process.geteuid!()) + 1n;
        }
        return stat;
      });
      await expect(create(paths.rootDir, [paths.ancestor, paths.rootDir]))
        .rejects.toMatchObject({ code: "not-owned" });
      expect(await fs.readdir(paths.rootDir)).toEqual([]);
    });

    it("rejects malformed lists, relative paths, noncanonical spellings, and aliases", async () => {
      const { ancestor, rootDir } = await fixture();
      const alias = path.join(ancestor, "alias");
      await fs.symlink(rootDir, alias, "dir");
      for (const invalid of [null, ancestor, [1], ["relative"], [`${ancestor}/.`], [alias]]) {
        await expect(create(rootDir, invalid as unknown as readonly string[])).rejects.toBeInstanceOf(TypeError);
      }
      expect(await fs.readdir(rootDir)).toEqual([]);
    });

    it("retains traversal, symlink, hardlink, and cleanup identity protections", async () => {
      const { ancestor, rootDir } = await fixture();
      const workspace = await create(rootDir, [ancestor]);
      const outside = path.join(ancestor, "outside");
      await fs.mkdir(outside, { mode: 0o700 });
      const kept = path.join(outside, "kept");
      await fs.writeFile(kept, "unchanged");
      await fs.symlink(kept, workspace.path("symlink"));
      await fs.link(kept, workspace.path("hardlink"));
      for (const name of ["../outside/kept", "symlink", "hardlink"]) {
        await expect(Promise.resolve().then(() => workspace.read(name))).rejects.toThrow();
      }
      await fs.rename(workspace.dir, `${workspace.dir}.original`);
      await fs.symlink(outside, workspace.dir, "dir");
      await expect(Promise.resolve().then(() => workspace.writeText("kept", "changed"))).rejects.toThrow();
      expect(await workspace.cleanup()).toBe("identity-mismatch");
      expect(await fs.readFile(kept, "utf8")).toBe("unchanged");
    });
  });
}
