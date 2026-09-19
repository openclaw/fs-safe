import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const exact = { dev: (1n << 56n) + 1n, ino: (1n << 56n) + 5n };
type Identity = typeof exact;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

async function fixture() {
  const base = await tempRoot("fs-safe-move-directory-identity-");
  const source = path.join(base, "source");
  await fs.mkdir(source);
  const child = path.join(source, "payload");
  await fs.writeFile(child, "copied");
  const move = {
    source, child,
    target: path.join(base, "target"),
    parked: path.join(base, "parked"),
    published: false,
    childRemoved: false,
    afterChild: undefined as (() => Promise<void>) | undefined,
  };
  const unlink = fs.unlink;
  vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
    await unlink(candidate);
    if (candidate === child) {
      move.childRemoved = true;
      await move.afterChild?.();
    }
  });
  return move;
}

function runMove(move: Awaited<ReturnType<typeof fixture>>) {
  return movePathWithCopyFallback({
    from: move.source, to: move.target, sourceHardlinks: "reject",
    onDestinationPublished: () => { move.published = true; },
  });
}

function project(stat: Stats | BigIntStats, identity: Identity, forceNumeric = false) {
  const bigint = typeof stat.ino === "bigint" && !forceNumeric;
  return Object.assign(Object.create(stat), {
    dev: bigint ? identity.dev : Number(identity.dev),
    ino: bigint ? identity.ino : Number(identity.ino),
  });
}

function observeSource(source: string, observe: (stat: Stats | BigIntStats) => Stats | BigIntStats) {
  const lstat = fsSync.lstatSync;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
    const stat = lstat(candidate, options as never);
    return candidate === source ? observe(stat) : stat;
  });
}

describe("exact directory cleanup receipts", () => {
  describe.each(["dev", "ino"] as const)("wide %s identity", (field) => {
    it.each([false, true])("retains the exact cleanup receipt when replaced=%s", async (replaced) => {
      const move = await fixture();
      let changed = false;
      let cleanupObservations = 0;
      expect(Number(exact[field] + 1n)).toBe(Number(exact[field]));
      observeSource(move.source, (stat) => {
        if (move.published) cleanupObservations++;
        return project(stat, { ...exact, [field]: exact[field] + (changed ? 1n : 0n) });
      });
      if (replaced) {
        move.afterChild = async () => {
          await fs.rename(move.source, move.parked);
          await fs.mkdir(move.source);
          changed = true;
        };
      }

      if (replaced) await expect(runMove(move)).rejects.toMatchObject({ code: "ESTALE" });
      else await expect(runMove(move)).resolves.toBeUndefined();

      // Observer-enabled cleanup also renews this ancestor before child unlink.
      expect(cleanupObservations).toBe(3);
      expect(move.childRemoved).toBe(true);
      await expect(fs.readFile(path.join(move.target, "payload"), "utf8")).resolves.toBe("copied");
      if (replaced) {
        await expect(fs.readdir(move.source)).resolves.toEqual([]);
        await expect(fs.readdir(move.parked)).resolves.toEqual([]);
      } else {
        await expect(fs.lstat(move.source)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  describe.each(["admission", "removal"] as const)("Windows unknown identity at %s", (boundary) => {
    describe.each(["dev", "ino"] as const)("unknown %s", (field) => {
      it.each([false, true])("bounds reinspection and proceeds only when recovered=%s", async (recovers) => {
        const move = await fixture();
        Object.defineProperty(process, "platform", { value: "win32" });
        const observations = { admission: 0, removal: 0 };
        const unknown = { ...exact, [field]: 0n };
        observeSource(move.source, (stat) => {
          // The copied directory has an exact receipt. Ambiguity introduced
          // after publication must not authorize further source removal.
          let identity = exact;
          if (move.published) {
            const phase = move.childRemoved ? "removal" : "admission";
            observations[phase]++;
            if (phase === boundary && (!recovers || observations[phase] === 1)) identity = unknown;
          }
          return project(stat, identity);
        });

        if (recovers) await expect(runMove(move)).resolves.toBeUndefined();
        else await expect(runMove(move)).rejects.toMatchObject({ code: "ESTALE" });

        expect(observations.admission).toBe(boundary === "admission" ? recovers ? 3 : 2 : 2);
        expect(observations.removal).toBe(boundary === "removal" ? 2 : recovers ? 1 : 0);
        expect(move.childRemoved).toBe(boundary === "removal" || recovers);
        await expect(fs.readFile(path.join(move.target, "payload"), "utf8")).resolves.toBe("copied");
        if (recovers) {
          await expect(fs.lstat(move.source)).rejects.toMatchObject({ code: "ENOENT" });
        } else if (boundary === "admission") {
          await expect(fs.readFile(move.child, "utf8")).resolves.toBe("copied");
        } else {
          await expect(fs.readdir(move.source)).resolves.toEqual([]);
        }
      });
    });
  });

  it("retains a known component across an incomplete cleanup admission", async () => {
    const move = await fixture();
    Object.defineProperty(process, "platform", { value: "win32" });
    let observations = 0;
    observeSource(move.source, (stat) => {
      if (!move.published) return project(stat, exact);
      observations++;
      return project(stat, observations === 1
        ? { ...exact, dev: 0n }
        : { ...exact, ino: exact.ino + 1n });
    });

    await expect(runMove(move)).rejects.toMatchObject({ code: "ESTALE" });

    expect(observations).toBe(2);
    expect(move.childRemoved).toBe(false);
    await expect(fs.readFile(move.child, "utf8")).resolves.toBe("copied");
    await expect(fs.readFile(path.join(move.target, "payload"), "utf8")).resolves.toBe("copied");
  });

  it.each(["admission", "removal"] as const)("rejects a numeric %s receipt without conversion", async (boundary) => {
    const move = await fixture();
    let rejectedObservations = 0;
    observeSource(move.source, (stat) => {
      const phase = move.childRemoved ? "removal" : "admission";
      const forceNumeric = move.published && phase === boundary;
      if (forceNumeric) rejectedObservations++;
      return project(stat, exact, forceNumeric);
    });

    await expect(runMove(move)).rejects.toMatchObject({ code: "ESTALE" });

    expect(rejectedObservations).toBe(1);
    expect(move.childRemoved).toBe(boundary === "removal");
    if (boundary === "admission") await expect(fs.readFile(move.child, "utf8")).resolves.toBe("copied");
    else await expect(fs.readdir(move.source)).resolves.toEqual([]);
    await expect(fs.readFile(path.join(move.target, "payload"), "utf8")).resolves.toBe("copied");
  });
  it.each(["dev", "ino"] as const)(
    "preserves a rounded-equal %s replacement before cleanup admission", async field => {
      const move = await fixture();
      let replaced = false;
      const rmdir = vi.spyOn(fs, "rmdir");
      expect(Number(exact[field] + 1n)).toBe(Number(exact[field]));
      observeSource(move.source, stat => project(stat, {
        ...exact, [field]: exact[field] + (replaced ? 1n : 0n),
      }));

      await expect(movePathWithCopyFallback({
        from: move.source,
        to: move.target,
        sourceHardlinks: "reject",
        onDestinationPublished: () => {
          move.published = true;
          fsSync.renameSync(move.source, move.parked);
          fsSync.mkdirSync(move.source);
          replaced = true;
        },
      })).rejects.toMatchObject({ code: "ESTALE" });

      expect(replaced).toBe(true);
      expect(move.childRemoved).toBe(false);
      expect(rmdir).not.toHaveBeenCalledWith(move.source);
      await expect(fs.readdir(move.source)).resolves.toEqual([]);
      await expect(fs.readFile(path.join(move.parked, "payload"), "utf8")).resolves.toBe("copied");
      await expect(fs.readFile(path.join(move.target, "payload"), "utf8")).resolves.toBe("copied");
    },
  );

  it("rejects persistent unknown directory identity before copying", async () => {
    const move = await fixture();
    Object.defineProperty(process, "platform", { value: "win32" });
    let exactObservations = 0;
    observeSource(move.source, stat => {
      if (typeof stat.dev === "bigint") exactObservations++;
      return project(stat, { ...exact, ino: 0n });
    });

    await expect(runMove(move)).rejects.toMatchObject({ code: "ESTALE" });

    expect(exactObservations).toBe(2);
    expect(move.published).toBe(false);
    expect(move.childRemoved).toBe(false);
    await expect(fs.readFile(move.child, "utf8")).resolves.toBe("copied");
    await expect(fs.lstat(move.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

});
