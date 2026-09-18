import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { fileObservation } from "../src/file-observation.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => { __setFsSafeTestHooksForTest(); vi.restoreAllMocks(); });

async function fixture() {
  const capability = await root(await tempRoot("stat-leaf-provenance-"));
  const relative = "state.lock", pathname = path.join(capability.rootReal, relative);
  await capability.create(relative, "original");
  return { capability, relative, pathname };
}

itPosix.each([false, true].flatMap(fallback => ["historical", "nested"].map(source => ({ fallback, source }))))(
  "withholds $source error receipts from a callback (fallback=$fallback)", async ({ fallback, source }) => {
    const { capability, relative, pathname } = await fixture();
    let prior: unknown;
    const createFailure = async () => {
      __setFsSafeTestHooksForTest({
        ...(fallback ? { beforeRootStatInitialObservation: () => {} } : {}),
        async beforeRootStatObservation(candidate) {
          if (candidate !== pathname) return;
          __setFsSafeTestHooksForTest();
          await fs.rename(pathname, `${pathname}.old`);
          await fs.writeFile(pathname, "replacement", { flag: "wx" });
        },
      });
      try { await capability.stat(relative); }
      catch (error) { prior = error; }
      expect(prior).toMatchObject({ code: "path-mismatch" });
    };
    if (source === "historical") {
      const first = fileObservation();
      await first.run(createFailure);
      expect(first.has(prior, `stat-leaf-changed:${pathname}`)).toBe(true);
    }
    __setFsSafeTestHooksForTest({
      ...(fallback ? { beforeRootStatInitialObservation: () => {} } : {}),
      async beforeRootStatObservation(candidate) {
        if (candidate !== pathname) return;
        __setFsSafeTestHooksForTest();
        if (source === "nested") await createFailure();
        throw prior;
      },
    });
    const current = fileObservation();
    let thrown: unknown;
    try { await current.run(() => capability.stat(relative)); }
    catch (error) { thrown = error; }
    expect(thrown).toBe(prior);
    expect(current.has(thrown, `stat-leaf-changed:${pathname}`)).toBe(false);
    expect(await fs.readFile(pathname, "utf8")).toBe("replacement");
    expect(await fs.readFile(`${pathname}.old`, "utf8")).toBe("original");
  },
);

itPosix.each([false, true].flatMap(fallback =>
  ["unknown", "negative", "unsafe-then-exact", "multilink-then-exact"].map(identity => ({ fallback, identity }))))(
  "withholds $identity metadata identity receipts (fallback=$fallback)", async ({ fallback, identity }) => {
    const { capability, relative, pathname } = await fixture();
    let calls = 0;
    __setFsSafeTestHooksForTest({
      ...(fallback ? { beforeRootStatInitialObservation: () => {} } : {}),
      async beforeRootStatObservation(candidate) {
        if (candidate !== pathname) return;
        __setFsSafeTestHooksForTest();
        await fs.rename(pathname, `${pathname}.old`);
        await fs.writeFile(pathname, "replacement", { flag: "wx" });
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((candidatePath, options) => {
          const stat = lstat(candidatePath, options as never);
          if (String(candidatePath) !== pathname) return stat;
          calls += 1;
          if (identity === "unknown") return Object.assign(stat, { ino: Number.NaN });
          if (identity === "negative") return Object.assign(stat, { ino: options?.bigint ? -1n : -1 });
          // The fallback compares one exact observation; keep that case ambiguous too.
          if (calls > 1) return stat;
          return Object.assign(stat, {
            ino: Number.MAX_SAFE_INTEGER + 1,
            ...(identity === "multilink-then-exact" ? { nlink: 2 } : {}),
          });
        });
      },
    });
    const observation = fileObservation();
    let failure: unknown;
    try { await observation.run(() => capability.stat(relative)); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "path-mismatch" });
    expect(observation.has(failure, `stat-leaf-changed:${pathname}`)).toBe(false);
    expect(calls).toBeGreaterThan(0);
    vi.restoreAllMocks();
    expect(await fs.readFile(pathname, "utf8")).toBe("replacement");
    expect(await fs.readFile(`${pathname}.old`, "utf8")).toBe("original");
  },
);
