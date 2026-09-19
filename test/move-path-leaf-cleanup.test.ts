import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback, type MovePathPublicationReceipt } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture(nested = false) {
  const base = await tempRoot("fs-safe-move-leaf-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  if (nested) await fs.mkdir(source);
  const leaf = nested ? path.join(source, "leaf") : source;
  await fs.writeFile(leaf, "original");
  const receipts: MovePathPublicationReceipt[] = [];
  return {
    source, target, leaf, parked: path.join(base, "parked"), receipts,
    publishedLeaf: nested ? path.join(target, "leaf") : target,
    options: {
      from: source, to: target, sourceHardlinks: "reject" as const,
      onDestinationPublished: (receipt: MovePathPublicationReceipt) => { receipts.push(receipt); },
    },
  };
}

async function expectPublished(move: Awaited<ReturnType<typeof fixture>>) {
  const stat = await fs.lstat(move.target, { bigint: true });
  expect(move.receipts).toEqual([{ path: move.target, dev: stat.dev, ino: stat.ino }]);
}

describe("copied leaf admission after mutation authority", () => {
  it.each([false, true])("preserves a substituted file, nested=%s", async nested => {
    const move = await fixture(nested);
    let replaced = false;
    await expect(movePathWithCopyFallback({
      ...move.options,
      assertBeforeMutation() {
        if (!move.receipts.length || replaced) return;
        fsSync.renameSync(move.leaf, move.parked);
        fsSync.writeFileSync(move.leaf, "replacement");
        replaced = true;
      },
    })).rejects.toMatchObject({ code: "ESTALE" });
    expect(replaced).toBe(true);
    await expect(fs.readFile(move.leaf, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(move.parked, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(move.publishedLeaf, "utf8")).resolves.toBe("original");
    await expectPublished(move);
  });

  it.skipIf(process.platform === "win32")("preserves a substituted dangling symlink", async () => {
    const move = await fixture();
    await fs.unlink(move.source);
    await fs.symlink("missing-original", move.source);
    let replaced = false;
    await expect(movePathWithCopyFallback({
      ...move.options,
      assertBeforeMutation() {
        if (!move.receipts.length || replaced) return;
        fsSync.renameSync(move.source, move.parked);
        fsSync.symlinkSync("missing-replacement", move.source);
        replaced = true;
      },
    })).rejects.toMatchObject({ code: "ESTALE" });
    expect(replaced).toBe(true);
    await expect(fs.readlink(move.source)).resolves.toBe("missing-replacement");
    await expect(fs.readlink(move.parked)).resolves.toBe("missing-original");
    await expect(fs.readlink(move.target)).resolves.toBe("missing-original");
    await expectPublished(move);
  });

  it.each([Object.assign(new Error("authority missing"), { code: "ENOENT" }), undefined])(
    "preserves the exact authority failure %s", async failure => {
      const move = await fixture();
      const unlink = vi.spyOn(fs, "unlink");
      await expect(movePathWithCopyFallback({
        ...move.options,
        assertBeforeMutation() { if (move.receipts.length) throw failure; },
      })).rejects.toBe(failure);
      expect(unlink).not.toHaveBeenCalledWith(move.source);
      await expect(fs.readFile(move.source, "utf8")).resolves.toBe("original");
      await expectPublished(move);
    },
  );

  it("preserves every substituted name in a stale hardlink group", async () => {
    const move = await fixture(true);
    const alias = path.join(move.source, "alias");
    await fs.link(move.leaf, alias);
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === move.source) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      await rename(from, to);
    });
    let replaced = false;
    await expect(movePathWithCopyFallback({
      ...move.options, sourceHardlinks: "allow",
      assertBeforeMutation() {
        if (!move.receipts.length || replaced) return;
        fsSync.renameSync(move.leaf, move.parked);
        fsSync.renameSync(alias, `${move.parked}-alias`);
        fsSync.writeFileSync(move.leaf, "replacement leaf");
        fsSync.writeFileSync(alias, "replacement alias");
        replaced = true;
      },
    })).rejects.toMatchObject({ code: "ESTALE" });
    expect(replaced).toBe(true);
    await expect(fs.readFile(move.leaf, "utf8")).resolves.toBe("replacement leaf");
    await expect(fs.readFile(alias, "utf8")).resolves.toBe("replacement alias");
    for (const entry of [move.parked, `${move.parked}-alias`, move.publishedLeaf, path.join(move.target, "alias")]) {
      await expect(fs.readFile(entry, "utf8")).resolves.toBe("original");
    }
    await expectPublished(move);
  });

  it.each(["EACCES", "ENOENT"])("propagates final observation %s without unlink", async code => {
    const move = await fixture();
    const failure = Object.assign(new Error("final observation failed"), { code });
    let authorized = false;
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      if (authorized && candidate === move.source) throw failure;
      return lstat(candidate, options as never);
    });
    const unlink = vi.spyOn(fs, "unlink");
    await expect(movePathWithCopyFallback({
      ...move.options,
      assertBeforeMutation() { if (move.receipts.length) authorized = true; },
    })).rejects.toBe(failure);
    expect(unlink).not.toHaveBeenCalledWith(move.source);
    await expect(fs.readFile(move.source, "utf8")).resolves.toBe("original");
    await expectPublished(move);
  });

  describe.skipIf(process.platform === "win32").each(["authority", "observer", "rename"])("%s ancestor changes", callback => {
    it.each(["parent", "root", "nested"])("preserves the original leaf through a replaced %s", async boundary => {
      const base = await tempRoot("fs-safe-move-ancestor-");
      const parent = path.join(base, "parent");
      const source = path.join(parent, "source");
      const directory = path.join(source, "nested");
      const leaf = path.join(directory, "leaf");
      const target = path.join(base, "target");
      const parked = path.join(base, "parked");
      const replacedPath = boundary === "parent" ? parent : boundary === "root" ? source : directory;
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(leaf, "original");
      let published = false, replaced = false;
      const replace = () => {
        if ((!published && callback !== "rename") || replaced) return;
        fsSync.renameSync(replacedPath, parked);
        fsSync.symlinkSync(parked, replacedPath, "dir");
        replaced = true;
      };
      await expect(movePathWithCopyFallback({
        from: source, to: target, sourceHardlinks: "reject",
        onDestinationPublished: callback === "rename" ? undefined : () => { published = true; if (callback === "observer") replace(); },
        assertBeforeMutation: callback === "authority" ? replace : undefined,
        assertBeforeRename: callback === "rename" ? replace : undefined,
      })).rejects.toMatchObject({ code: "ESTALE" });
      expect(replaced).toBe(true);
      await expect(fs.readFile(path.join(parked, path.relative(replacedPath, leaf)), "utf8")).resolves.toBe("original");
      await expect(fs.readFile(path.join(target, "nested", "leaf"), "utf8")).resolves.toBe("original");
      expect(fsSync.lstatSync(replacedPath).isSymbolicLink()).toBe(true);
    });
  });

  it.each(["directory", "missing"])("reports a %s source-parent replacement as stale", async replacement => {
    const move = await fixture(true);
    let replaced = false;
    await expect(movePathWithCopyFallback({
      ...move.options, from: move.leaf,
      assertBeforeRename() {
        if (replaced) return;
        fsSync.renameSync(move.source, move.parked);
        if (replacement === "directory") fsSync.mkdirSync(move.source);
        replaced = true;
      },
    })).rejects.toMatchObject({ code: "ESTALE" });
    expect(replaced).toBe(true);
    await expect(fs.readFile(path.join(move.parked, "leaf"), "utf8")).resolves.toBe("original");
    await expect(fs.readFile(move.target, "utf8")).resolves.toBe("original");
  });

  it.skipIf(process.platform === "win32")("keeps an initially admitted symlink parent usable", async () => {
    const move = await fixture(true);
    const alias = `${move.source}-alias`;
    await fs.symlink(move.source, alias, "dir");
    await movePathWithCopyFallback({
      ...move.options, from: path.join(alias, "leaf"), assertBeforeMutation() {},
    });
    await expect(fs.readFile(move.target, "utf8")).resolves.toBe("original");
    await expect(fs.readdir(move.source)).resolves.toEqual([]);
    expect(fsSync.lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  it.each(["none", "observer", "authority"])("keeps cleanup observations bounded, callback=%s", async callback => {
    const move = await fixture();
    const events: string[] = [];
    let published = false;
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === move.target) published = true;
    });
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
      if (published && candidate === move.source) events.push("stat");
      return lstat(candidate, options as never);
    });
    const unlink = fs.unlink;
    vi.spyOn(fs, "unlink").mockImplementation(candidate => {
      if (candidate === move.source) events.push("unlink");
      return unlink(candidate);
    });
    await movePathWithCopyFallback({
      ...move.options,
      onDestinationPublished: callback === "none" ? undefined : move.options.onDestinationPublished,
      assertBeforeMutation: callback === "authority" ? () => {
        if (!move.receipts.length) return;
        events.push("authority");
        queueMicrotask(() => { events.push("microtask"); });
      } : undefined,
    });
    expect(events).toEqual(callback === "authority"
      ? ["stat", "authority", "stat", "unlink", "microtask"]
      : callback === "observer" ? ["stat", "stat", "unlink"] : ["stat", "unlink"]);
    if (callback !== "none") await expectPublished(move);
    await expect(fs.readFile(move.target, "utf8")).resolves.toBe("original");
  });
});
