import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  movePathWithCopyFallback,
  type MovePathWithCopyFallbackOptions,
} from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

const routes = [
  { name: "direct rename", sourceHardlinks: "allow", fallback: false },
  { name: "staged copy", sourceHardlinks: "reject", fallback: false },
  { name: "EXDEV fallback", sourceHardlinks: "allow", fallback: true },
] as const;

async function moveFixture() {
  const root = await tempRoot("fs-safe-move-authority-");
  const sourceParent = path.join(root, "incoming");
  const targetParent = path.join(root, "installed");
  await fs.mkdir(sourceParent);
  await fs.mkdir(targetParent);
  const source = path.join(sourceParent, "payload.txt");
  const target = path.join(targetParent, "payload.txt");
  await fs.writeFile(source, "replacement");
  await fs.writeFile(target, "original");
  return { source, target, targetParent };
}

type MoveFixture = Awaited<ReturnType<typeof moveFixture>>;

function observeRename(fixture: MoveFixture, fallback: boolean, onDispatch?: () => void) {
  const rename = fs.rename;
  return vi.spyOn(fs, "rename").mockImplementation((from, to) => {
    onDispatch?.();
    if (fallback && from === fixture.source && to === fixture.target) {
      return Promise.reject(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    }
    return rename(from, to);
  });
}

async function expectUnpublished(fixture: MoveFixture) {
  await expect(fs.readFile(fixture.source, "utf8")).resolves.toBe("replacement");
  await expect(fs.readFile(fixture.target, "utf8")).resolves.toBe("original");
  await expect(fs.readdir(fixture.targetParent)).resolves.toEqual(["payload.txt"]);
}

describe("movePathWithCopyFallback publication authority", () => {
  it.each(routes)("refuses $name when authority expires during directory preparation", async (route) => {
    const fixture = await moveFixture();
    const expired = new Error("move owner expired");
    let active = true;
    const rename = observeRename(fixture, route.fallback);
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lstat = fs.lstat;
    let pausedOnce = false;
    vi.spyOn(fs, "lstat").mockImplementation(async (candidate, options) => {
      const stat = await lstat(candidate, options as never);
      if (
        !pausedOnce && candidate === fixture.targetParent &&
        (!route.fallback || rename.mock.calls.length > 0)
      ) {
        pausedOnce = true;
        paused.resolve();
        // Deliver unchanged filesystem evidence after the caller loses authority.
        await release.promise;
      }
      return stat;
    });
    const move = movePathWithCopyFallback({
      from: fixture.source,
      to: fixture.target,
      sourceHardlinks: route.sourceHardlinks,
      assertBeforeRename: () => {
        if (!active) throw expired;
      },
    }).catch((error: unknown) => error);

    try {
      await Promise.race([
        paused.promise,
        move.then(() => { throw new Error("move settled before the preparation barrier"); }),
      ]);
      active = false;
      release.resolve();
      expect(await move).toBe(expired);
      expect(rename).toHaveBeenCalledTimes(route.fallback ? 1 : 0);
      await expectUnpublished(fixture);
    } finally {
      release.resolve();
      await move;
    }
  });

  it.each(routes)("does not yield between approval and $name dispatch", async (route) => {
    const fixture = await moveFixture();
    const events: string[] = [];
    observeRename(fixture, route.fallback, () => events.push("rename"));

    await movePathWithCopyFallback({
      from: fixture.source,
      to: fixture.target,
      sourceHardlinks: route.sourceHardlinks,
      assertBeforeRename: () => {
        events.push("assert");
        queueMicrotask(() => events.push("yield"));
      },
    });

    const attempt = ["assert", "rename", "yield"];
    expect(events).toEqual(route.fallback ? [...attempt, ...attempt] : attempt);
    await expect(fs.readFile(fixture.target, "utf8")).resolves.toBe("replacement");
    await expect(fs.lstat(fixture.source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(fixture.targetParent)).resolves.toEqual(["payload.txt"]);
  });

  it.each(["allow", "reject"] as const)(
    "captures the initiating callback before awaiting with hardlinks %s",
    async (sourceHardlinks) => {
      const fixture = await moveFixture();
      const expired = new Error("original owner expired");
      const successor = vi.fn(() => {});
      const options: MovePathWithCopyFallbackOptions = {
        from: fixture.source,
        to: fixture.target,
        sourceHardlinks,
        assertBeforeRename: () => { throw expired; },
      };

      const move = movePathWithCopyFallback(options);
      options.assertBeforeRename = successor;

      await expect(move).rejects.toBe(expired);
      expect(successor).not.toHaveBeenCalled();
      await expectUnpublished(fixture);
    },
  );

  it.each(["EXDEV", "EPERM"])("does not copy when the assertion throws %s", async (code) => {
    const fixture = await moveFixture();
    const denied = Object.assign(new Error("caller denied publication"), { code });
    const rename = vi.spyOn(fs, "rename");
    const open = vi.spyOn(fs, "open");

    await expect(movePathWithCopyFallback({
      from: fixture.source,
      to: fixture.target,
      assertBeforeRename: () => { throw denied; },
    })).rejects.toBe(denied);

    expect(rename).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await expectUnpublished(fixture);
  });

  describe.each(["allow", "reject"] as const)("synchronous contract with hardlinks %s", (sourceHardlinks) => {
    it.each([
      { name: "false", create: () => false },
      { name: "null", create: () => null },
      { name: "fulfilled Promise", create: () => Promise.resolve() },
      { name: "rejected Promise", create: () => Promise.reject(new Error("async denial")) },
      {
        name: "rejecting thenable",
        create: () => ({
          then(_resolve: unknown, reject: (reason: Error) => void) {
            reject(new Error("thenable denial"));
          },
        }),
      },
    ])("refuses $name without publication or an unhandled rejection", async ({ create }) => {
      const fixture = await moveFixture();
      const rename = vi.spyOn(fs, "rename");
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", observeUnhandled);
      try {
        await expect(movePathWithCopyFallback({
          from: fixture.source,
          to: fixture.target,
          sourceHardlinks,
          assertBeforeRename: create,
        })).rejects.toBeInstanceOf(TypeError);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(rename).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
        await expectUnpublished(fixture);
      } finally {
        process.off("unhandledRejection", observeUnhandled);
      }
    });
  });
});
