import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  movePathWithCopyFallback,
  type MovePathPublicationReceipt,
} from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
});

const routes = [
  { name: "direct rename", hardlinks: "allow", code: undefined },
  { name: "hardlink-reject copy", hardlinks: "reject", code: undefined },
  { name: "EXDEV copy", hardlinks: "allow", code: "EXDEV" },
  { name: "Windows EPERM copy", hardlinks: "allow", code: "EPERM" },
] as const;
type Route = typeof routes[number];

async function fixture(route: Route) {
  const root = await tempRoot("fs-safe-move-receipt-");
  const source = path.join(root, "source");
  const parent = path.join(root, "installed");
  const target = path.join(parent, "target");
  await fs.mkdir(source);
  await fs.mkdir(parent);
  await fs.writeFile(path.join(source, "a.txt"), "a");
  await fs.writeFile(path.join(source, "b.txt"), "b");
  const originalRename = fs.rename;
  if (route.code === "EPERM") {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  }
  const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (route.code && from === source) {
      throw Object.assign(new Error("initial rename failed"), { code: route.code });
    }
    await originalRename(from, to);
  });
  return { source, target, parent, rename, sourceHardlinks: route.hardlinks };
}

function expectReceipt(receipt: MovePathPublicationReceipt, target: string) {
  const stat = fsSync.lstatSync(target, { bigint: true });
  expect(receipt).toEqual({ path: target, dev: stat.dev, ino: stat.ino });
}

async function expectComplete(target: string) {
  await expect(fs.readFile(path.join(target, "a.txt"), "utf8")).resolves.toBe("a");
  await expect(fs.readFile(path.join(target, "b.txt"), "utf8")).resolves.toBe("b");
}

describe("move publication receipts and mutation authority", () => {
  it.each(routes)("reports exactly one committed receipt for $name", async (route) => {
    const move = await fixture(route);
    const receipts: MovePathPublicationReceipt[] = [];
    const options = {
      from: move.source,
      to: move.target,
      sourceHardlinks: move.sourceHardlinks,
      onDestinationPublished(receipt: MovePathPublicationReceipt) {
        expectReceipt(receipt, move.target);
        receipts.push(receipt);
      },
    };
    const result = movePathWithCopyFallback(options);
    options.onDestinationPublished = () => { throw new Error("successor callback"); };
    await expect(result).resolves.toBeUndefined();
    expect(receipts).toHaveLength(1);
    await expectComplete(move.target);
    await expect(fs.lstat(move.source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains bigint identity bits from the admitted rename source", async () => {
    const move = await fixture(routes[0]);
    const identity = { dev: 9007199254740995n, ino: 9007199254740997n };
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      const stat = await lstat(candidate, options as never);
      if (candidate === move.source && options && typeof options === "object" && options.bigint) {
        return Object.assign(stat, identity);
      }
      return stat;
    });
    const published = vi.fn();
    await movePathWithCopyFallback({
      from: move.source,
      to: move.target,
      onDestinationPublished: published,
    });
    expect(published).toHaveBeenCalledExactlyOnceWith({ path: move.target, ...identity });
  });

  describe.each(routes.slice(1))("$name source cleanup", (route) => {
    it.each(["publication", "awaited stat", "first unlink", "last unlink"] as const)(
      "preserves remaining source after revocation at %s", async (boundary) => {
        const move = await fixture(route);
        const expired = Object.assign(new Error("owner expired"), { code: "ENOTEMPTY" });
        let active = true;
        let published = false;
        const receipts: MovePathPublicationReceipt[] = [];
        const removed: string[] = [];
        const unlink = fs.unlink;
        vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
          await unlink(candidate);
          removed.push(String(candidate));
          if (boundary === "first unlink" || (boundary === "last unlink" && removed.length === 2)) {
            active = false;
          }
        });
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
          const stat = await lstat(candidate, options as never);
          if (boundary === "awaited stat" && published && path.dirname(String(candidate)) === move.source) {
            active = false;
          }
          return stat;
        });
        await expect(movePathWithCopyFallback({
          from: move.source,
          to: move.target,
          sourceHardlinks: move.sourceHardlinks,
          assertBeforeMutation: () => {
            if (!active) throw expired;
          },
          onDestinationPublished: (receipt) => {
            published = true;
            receipts.push(receipt);
            if (boundary === "publication") active = false;
          },
        })).rejects.toBe(expired);
        expect(receipts).toHaveLength(1);
        expectReceipt(receipts[0]!, move.target);
        await expectComplete(move.target);
        const expectedRemovals = boundary === "last unlink" ? 2
          : boundary === "first unlink" ? 1 : 0;
        expect(removed).toHaveLength(expectedRemovals);
        const remaining = await fs.readdir(move.source);
        expect(remaining).toHaveLength(2 - expectedRemovals);
        for (const name of remaining) {
          await expect(fs.readFile(path.join(move.source, name), "utf8")).resolves.toBe(name[0]);
        }
      },
    );
  });

  describe.each(routes)("$name failure receipts", (route) => {
    it.each(["EXDEV", "EPERM"])("retains publication when the observer throws %s", async (code) => {
      const move = await fixture(route);
      const denied = Object.assign(new Error("observer failed"), { code });
      const published = vi.fn((receipt: MovePathPublicationReceipt) => {
        expectReceipt(receipt, move.target);
        throw denied;
      });
      await expect(movePathWithCopyFallback({
        from: move.source,
        to: move.target,
        sourceHardlinks: move.sourceHardlinks,
        onDestinationPublished: published,
      })).rejects.toBe(denied);
      expect(published).toHaveBeenCalledTimes(1);
      expect(move.rename).toHaveBeenCalledTimes(route.code ? 2 : 1);
      await expectComplete(move.target);
      if (route.name === "direct rename") {
        await expect(fs.lstat(move.source)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expectComplete(move.source);
      }
    });

    it("reports publication before a failing post-rename guard", async () => {
      const move = await fixture(route);
      const failed = Object.assign(new Error("post-rename check failed"), { code: "EXDEV" });
      let committed = false;
      const published = vi.fn((receipt: MovePathPublicationReceipt) => {
        expectReceipt(receipt, move.target);
        committed = true;
      });
      const lstat = fsSync.lstatSync;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
        if (committed && candidate === move.parent) throw failed;
        return lstat(candidate, options as never);
      });
      await expect(movePathWithCopyFallback({
        from: move.source,
        to: move.target,
        sourceHardlinks: move.sourceHardlinks,
        onDestinationPublished: published,
      })).rejects.toBe(failed);
      expect(published).toHaveBeenCalledTimes(1);
      expect(move.rename).toHaveBeenCalledTimes(route.code ? 2 : 1);
      await expectComplete(move.target);
      if (route.name !== "direct rename") await expectComplete(move.source);
    });

    it("never reports a publication for a failed rename", async () => {
      const move = await fixture(route);
      const failed = Object.assign(new Error("rename failed"), { code: "EACCES" });
      move.rename.mockRejectedValue(failed);
      const published = vi.fn();
      await expect(movePathWithCopyFallback({
        from: move.source,
        to: move.target,
        sourceHardlinks: move.sourceHardlinks,
        onDestinationPublished: published,
      })).rejects.toBe(failed);
      expect(published).not.toHaveBeenCalled();
      await expectComplete(move.source);
      await expect(fs.lstat(move.target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["EXDEV", "EPERM"])("does not reinterpret mutation authority errors with code %s", async (code) => {
    const move = await fixture(routes[0]);
    const expired = Object.assign(new Error("owner expired"), { code });
    const published = vi.fn();
    const options = {
      from: move.source,
      to: move.target,
      assertBeforeMutation: () => { throw expired; },
      onDestinationPublished: published,
    };
    const result = movePathWithCopyFallback(options);
    options.assertBeforeMutation = vi.fn();
    await expect(result).rejects.toBe(expired);
    expect(move.rename).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    await expectComplete(move.source);
  });

  it.each(["assertBeforeMutation", "onDestinationPublished"] as const)(
    "rejects async %s without an unhandled rejection", async (hook) => {
      const move = await fixture(routes[1]);
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", observeUnhandled);
      try {
        await expect(movePathWithCopyFallback({
          from: move.source,
          to: move.target,
          sourceHardlinks: move.sourceHardlinks,
          [hook]: async () => { throw new Error("async refusal"); },
        })).rejects.toBeInstanceOf(TypeError);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
        await expectComplete(move.source);
        if (hook === "onDestinationPublished") await expectComplete(move.target);
        else expect(move.rename).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", observeUnhandled);
      }
    },
  );
});
