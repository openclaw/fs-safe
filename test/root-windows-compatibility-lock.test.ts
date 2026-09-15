import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFileLock } from "../src/file-lock.js";
import { configureFsSafeNative, root } from "../src/index.js";
import * as queues from "../src/write-queue.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const policy = "verify-content-with-lock" as const;

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

async function holdLock(directory: string, relative: string) {
  const sidecar = path.join(directory, `.fs-safe-write-${createHash("sha256").update(relative).digest("hex")}.lock`);
  const holder = await acquireFileLock(directory, {
    managerKey: `spelling-test-holder:${directory}`, lockPath: sidecar,
    payload: () => ({ createdAt: new Date().toISOString() }),
  });
  const observed = Promise.withResolvers<void>();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === sidecar && typeof args[1] === "number" &&
      (args[1] & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0) observed.resolve();
    return handle;
  });
  return { holder, observed };
}

describe.skipIf(process.platform !== "win32")("Windows buffered compatibility lock spelling", () => {
  describe.each(["off", "auto"] as const)("native %s", nativeMode => {
    beforeEach(() => configureFsSafeNative({ mode: nativeMode }));

    it.for(["actual/target", "alias/target", "actual/TARGET"])(
      "coordinates %s with an existing effective-target holder or refuses the spelling",
      async (relative, context) => {
        const directory = await tempRoot("fs-safe-win-lock-spelling-");
        const actual = path.join(directory, "actual");
        await fs.mkdir(actual);
        const target = path.join(actual, "target");
        await fs.writeFile(target, "previous");
        await fs.symlink(actual, path.join(directory, "alias"), "junction");
        if (relative.endsWith("TARGET")) {
          const alternate = await fs.stat(path.join(directory, relative), { bigint: true }).catch(() => undefined);
          if (alternate?.ino !== (await fs.stat(target, { bigint: true })).ino) {
            context.skip("fixture directory does not alias the selected case spellings");
            return;
          }
        }
        const safe = await root(directory, { renameIdentity: policy });
        const { holder, observed } = await holdLock(directory, "actual/target");
        const serialize = vi.spyOn(queues, "serializePathWrite");
        const mutate = vi.fn();
        const writing = safe.write(relative, "next", { assertBeforeMutation: mutate });
        try {
          const result = await Promise.race([
            observed.promise.then(() => "blocked" as const),
            writing.then(() => "completed" as const, error => error),
          ]);
          expect(result).not.toBe("completed");
          expect(mutate).not.toHaveBeenCalled();
          expect(await fs.readFile(target, "utf8")).toBe("previous");
          if (result === "blocked") {
            expect(serialize.mock.calls.some(([key]) => key === target)).toBe(true);
            await holder.release();
            await writing;
            expect(await fs.readFile(target, "utf8")).toBe("next");
          } else {
            // Native canonicalization may preserve a case alias. The bounded
            // protocol must reject that spelling, never select a second lock.
            expect(relative).toBe("actual/TARGET");
            expect(result).toMatchObject({ code: "path-alias" });
          }
        } finally {
          await holder.release();
          await writing.catch(() => undefined);
        }
      },
    );

    it("refuses a missing case variant while the admitted spelling waits for its holder", async () => {
      const directory = await tempRoot("fs-safe-win-lock-missing-case-");
      const safe = await root(directory, { renameIdentity: policy });
      const { holder, observed } = await holdLock(directory, "target");
      const lowerMutation = vi.fn(), upperMutation = vi.fn();
      const writing = safe.write("target", "next", { assertBeforeMutation: lowerMutation });
      try {
        await Promise.race([
          observed.promise,
          writing.then(() => { throw new Error("write passed the held compatibility lock"); }),
        ]);
        await expect(safe.write("TARGET", "other", { assertBeforeMutation: upperMutation }))
          .rejects.toMatchObject({ code: "path-alias" });
        expect(lowerMutation).not.toHaveBeenCalled();
        expect(upperMutation).not.toHaveBeenCalled();
        await expect(fs.lstat(path.join(directory, "target"))).rejects.toMatchObject({ code: "ENOENT" });
        await holder.release();
        await writing;
        expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("next");
      } finally {
        await holder.release();
        await writing.catch(() => undefined);
      }
    });

    it("keeps publication on the selected destination if the original parent alias changes", async () => {
      const directory = await tempRoot("fs-safe-win-lock-bound-alias-");
      const actual = path.join(directory, "actual"), other = path.join(directory, "other");
      await fs.mkdir(actual);
      await fs.mkdir(other);
      await fs.writeFile(path.join(actual, "target"), "previous");
      await fs.writeFile(path.join(other, "target"), "other");
      const alias = path.join(directory, "alias");
      await fs.symlink(actual, alias, "junction");
      const safe = await root(directory, { renameIdentity: policy });
      let switched = false;
      await safe.write("alias/target", "next", {
        assertBeforeMutation: () => {
          if (switched) return;
          fsSync.unlinkSync(alias);
          fsSync.symlinkSync(other, alias, "junction");
          switched = true;
        },
      });
      expect(switched).toBe(true);
      expect(await fs.readFile(path.join(actual, "target"), "utf8")).toBe("next");
      expect(await fs.readFile(path.join(other, "target"), "utf8")).toBe("other");
    });

    it.each(["UPPER/target", "missing/caf\u00e9", "missing/file name"])(
      "refuses unsupported missing components in %s before mutation", async relative => {
        const directory = await tempRoot("fs-safe-win-lock-unsupported-");
        const safe = await root(directory, { renameIdentity: policy });
        const mutate = vi.fn();
        await expect(safe.write(relative, "payload", { assertBeforeMutation: mutate }))
          .rejects.toMatchObject({ code: "path-alias" });
        expect(mutate).not.toHaveBeenCalled();
        expect(await fs.readdir(directory)).toEqual([]);
      },
    );
  });
});
