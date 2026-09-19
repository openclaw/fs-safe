import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import * as rootContext from "../src/root-context.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

describe("overwrite move authority fences", () => {
  it.each(["source", "target"])("binds separately resolved %s routes to the selected rename paths", async selected => {
    const directory = await tempRoot("fs-safe-move-separate-route-");
    for (const name of ["a", "b", "direct"]) {
      fs.mkdirSync(path.join(directory, name)); fs.writeFileSync(path.join(directory, name, "item"), name);
    }
    const alias = path.join(directory, "alias");
    fs.symlinkSync(path.join(directory, "a"), alias, process.platform === "win32" ? "junction" : "dir");
    const scoped = await root(directory);
    const resolve = rootContext.resolvePathInRoot;
    let changed = false;
    vi.spyOn(rootContext, "resolvePathInRoot").mockImplementation(async (...args) => {
      const result = await resolve(...args);
      if (args[1] === "alias/item" && args[2]?.resolveCanonical === true && !changed) {
        fs.unlinkSync(alias);
        fs.symlinkSync(path.join(directory, "b"), alias, process.platform === "win32" ? "junction" : "dir");
        changed = true;
      }
      return result;
    });
    await expect(scoped.move(selected === "source" ? "alias/item" : "direct/item",
      selected === "source" ? "direct/item" : "alias/item", {
        overwrite: true, mutationSymlinks: "follow-parents-within-root", assertBeforeMutation() {},
      })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(changed).toBe(true);
    for (const name of ["a", "b", "direct"]) expect(fs.readFileSync(path.join(directory, name, "item"), "utf8")).toBe(name);
  });

  it.each(["source", "target"])("rejects retargeting an admitted %s parent alias", async selected => {
    const directory = await tempRoot("fs-safe-move-callback-route-");
    for (const name of ["a", "b", "direct"]) {
      fs.mkdirSync(path.join(directory, name));
      fs.writeFileSync(path.join(directory, name, "item"), name);
    }
    const alias = path.join(directory, "alias");
    fs.symlinkSync(path.join(directory, "a"), alias, process.platform === "win32" ? "junction" : "dir");
    const scoped = await root(directory);
    let changed = false;
    await expect(scoped.move(selected === "source" ? "alias/item" : "direct/item",
      selected === "source" ? "direct/item" : "alias/item", {
        overwrite: true, mutationSymlinks: "follow-parents-within-root",
        assertBeforeMutation() {
          fs.unlinkSync(alias);
          fs.symlinkSync(path.join(directory, "b"), alias, process.platform === "win32" ? "junction" : "dir");
          changed = true;
        },
      })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(changed).toBe(true);
    for (const name of ["a", "b", "direct"]) expect(fs.readFileSync(path.join(directory, name, "item"), "utf8")).toBe(name);
  });

  it.each(["root", "source-parent", "target-parent", "missing-target-parent", "source", "hardlink"])(
    "preserves entries after the callback changes %s", async change => {
      const workspace = await tempRoot("fs-safe-move-callback-");
      const boundary = path.join(workspace, "root");
      const outside = path.join(workspace, "outside");
      for (const base of [boundary, outside]) {
        fs.mkdirSync(path.join(base, "src"), { recursive: true });
        fs.mkdirSync(path.join(base, "dst"));
        fs.writeFileSync(path.join(base, "src/item"), base === boundary ? "original" : "outside source");
        fs.writeFileSync(path.join(base, "dst/item"), base === boundary ? "destination" : "outside destination");
      }
      const scoped = await root(boundary);
      const source = path.join(boundary, "src/item");
      let changed = false;
      const to = change === "missing-target-parent" ? "missing/item" : "dst/item";
      const failure = await scoped.move("src/item", to, {
        overwrite: true,
        assertBeforeMutation() {
          if (changed) return;
          if (change === "source") {
            fs.renameSync(source, path.join(workspace, "saved-file"));
            fs.writeFileSync(source, "replacement");
          } else if (change === "hardlink") {
            fs.linkSync(source, path.join(workspace, "alias"));
          } else {
            const selected = change === "root" ? boundary : path.join(boundary,
              change === "source-parent" ? "src" : change === "target-parent" ? "dst" : "missing");
            if (change !== "missing-target-parent") fs.renameSync(selected, path.join(workspace, "saved"));
            fs.symlinkSync(change === "root" ? outside : path.join(outside, change === "source-parent" ? "src" : "dst"),
              selected, process.platform === "win32" ? "junction" : "dir");
          }
          changed = true;
        },
      }).catch(error => error);
      expect(changed).toBe(true);
      expect(fs.readFileSync(path.join(outside, "src/item"), "utf8")).toBe("outside source");
      expect(fs.readFileSync(path.join(outside, "dst/item"), "utf8")).toBe("outside destination");
      if (change === "source") {
        expect(fs.readFileSync(source, "utf8")).toBe("replacement");
        expect(fs.readFileSync(path.join(workspace, "saved-file"), "utf8")).toBe("original");
      } else if (change === "hardlink") {
        expect(fs.readFileSync(source, "utf8")).toBe("original");
        expect(fs.readFileSync(path.join(workspace, "alias"), "utf8")).toBe("original");
      }
      expect(failure).toHaveProperty("code");
    },
  );

  it.each(["file", "directory"])("keeps unchanged %s moves working with callbacks", async kind => {
    const directory = await tempRoot("fs-safe-move-callback-control-");
    const source = path.join(directory, "source");
    if (kind === "file") fs.writeFileSync(source, "payload");
    else { fs.mkdirSync(source); fs.writeFileSync(path.join(source, "child"), "payload"); }
    const scoped = await root(directory);
    let calls = 0;
    await scoped.move("source", "target", { overwrite: true, assertBeforeMutation() { calls++; } });
    expect(calls).toBeGreaterThan(0);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(directory, kind === "file" ? "target" : "target/child"), "utf8")).toBe("payload");
  });

  it.skipIf(process.platform === "win32")("preserves default final-symlink replacement with a callback", async () => {
    const directory = await tempRoot("fs-safe-move-callback-link-");
    fs.writeFileSync(path.join(directory, "source"), "payload");
    fs.writeFileSync(path.join(directory, "keep"), "unrelated");
    fs.symlinkSync(path.join(directory, "keep"), path.join(directory, "target"));
    const scoped = await root(directory);
    await scoped.move("source", "target", { overwrite: true, assertBeforeMutation() {} });
    expect(fs.lstatSync(path.join(directory, "target")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(directory, "target"), "utf8")).toBe("payload");
    expect(fs.readFileSync(path.join(directory, "keep"), "utf8")).toBe("unrelated");
  });
});

for (const recursive of [false, true]) {
  describe(`removal authority fences (recursive=${recursive})`, () => {
    it("rejects newly observed reparse metadata with unchanged identity", async () => {
      const directory = await tempRoot("fs-safe-remove-callback-reparse-");
      const scoped = await root(directory);
      const target = path.join(scoped.rootReal, "item");
      fs.writeFileSync(target, "original");
      let changed = false;
      const lstat = fs.lstatSync;
      vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
        const stat = Reflect.apply(lstat, fs, args);
        // Windows reparse metadata can change without replacing the file ID.
        if (changed && String(args[0]) === target) stat.isSymbolicLink = () => true;
        return stat;
      });
      await expect(scoped.remove("item", {
        recursive, mutationSymlinks: "reject", assertBeforeMutation() { changed = true; },
      })).rejects.toMatchObject({ code: "symlink" });
      expect(changed).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe("original");
    });

    for (const force of [false, true]) {
      it.each(["root", "ancestor", "parent", "leaf"])(`preserves replacements of %s (force=${force})`, async change => {
        const workspace = await tempRoot("fs-safe-remove-callback-");
        const boundary = path.join(workspace, "root");
        const outside = path.join(workspace, "outside");
        for (const base of [boundary, outside]) {
          fs.mkdirSync(path.join(base, "ancestor/parent"), { recursive: true });
          fs.writeFileSync(path.join(base, "ancestor/parent/item"), base === boundary ? "original" : "outside");
        }
        const scoped = await root(boundary);
        const target = path.join(boundary, "ancestor/parent/item");
        let changed = false;
        const failure = await scoped.remove("ancestor/parent/item", {
          recursive, force,
          assertBeforeMutation() {
            if (changed) return;
            const suffix = change === "root" ? "" : change === "ancestor" ? "ancestor"
              : change === "parent" ? "ancestor/parent" : "ancestor/parent/item";
            const selected = path.join(boundary, suffix);
            fs.renameSync(selected, path.join(workspace, "saved"));
            if (change === "leaf") fs.writeFileSync(selected, "replacement");
            else fs.symlinkSync(path.join(outside, suffix), selected, process.platform === "win32" ? "junction" : "dir");
            changed = true;
          },
        }).catch(error => error);
        expect(changed).toBe(true);
        expect(fs.readFileSync(path.join(outside, "ancestor/parent/item"), "utf8")).toBe("outside");
        if (change === "leaf") expect(fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(failure).toMatchObject({ code: "path-mismatch" });
      });

      it(`honors cancellation set by the callback (force=${force})`, async () => {
        const directory = await tempRoot("fs-safe-remove-callback-abort-");
        const target = path.join(directory, "item");
        fs.writeFileSync(target, "original");
        const scoped = await root(directory);
        const controller = new AbortController();
        const reason = { code: "ENOENT", synthetic: true };
        await expect(scoped.remove("item", {
          recursive, force, signal: controller.signal,
          assertBeforeMutation() { controller.abort(reason); },
        })).rejects.toBe(reason);
        expect(fs.readFileSync(target, "utf8")).toBe("original");
      });
    }

    it("keeps callback error identity, missing force behavior, and hardlink removal", async () => {
      const directory = await tempRoot("fs-safe-remove-callback-controls-");
      const target = path.join(directory, "item"), alias = path.join(directory, "alias");
      fs.writeFileSync(target, "original");
      fs.linkSync(target, alias);
      const scoped = await root(directory);
      const rejection = { code: "ENOENT", synthetic: "callback" };
      await expect(scoped.remove("item", { recursive, force: true, assertBeforeMutation() { throw rejection; } }))
        .rejects.toBe(rejection);
      expect(fs.existsSync(target)).toBe(true);
      await scoped.remove("item", { recursive, assertBeforeMutation() {} });
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readFileSync(alias, "utf8")).toBe("original");
      await scoped.remove("alias", { recursive, force: true, assertBeforeMutation() { fs.unlinkSync(alias); } });
      expect(fs.readdirSync(directory)).toEqual([]);
    });
  });
}
