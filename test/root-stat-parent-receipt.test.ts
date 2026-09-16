import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";
import { getFsSafeTestHooks } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const backends = ["off", "native", "native-unavailable"] as const;
type Backend = typeof backends[number];

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

async function scriptedLookup(
  backend: Backend,
  code: "ENOENT" | "ENOTDIR" | "EACCES",
  parentChanges: boolean,
  targetExists: boolean,
) {
  const rootDir = await tempRoot("fs-safe-stat-parent-receipt-");
  const selected = path.join(rootDir, "selected");
  const target = path.join(selected, "value");
  await fs.mkdir(selected);
  if (targetExists) await fs.writeFile(target, "metadata must not be accepted");
  configureFsSafeNative({ mode: "off" });
  const capability = await root(rootDir);
  expect(getFsSafeTestHooks()).toBeUndefined();

  // Model filesystem observations, not an actual native or race proof. The
  // selected parent's identity changes only after its canonical admission.
  const events: string[] = [];
  let targetLookups = 0;
  let changed = false;
  const failure = Object.assign(new Error("initial target lookup failed"), { code });
  const rawLstat = fsSync.lstatSync.bind(fsSync);
  const rawRealpath = realpathSync.native.bind(realpathSync);
  vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
    const canonical = rawRealpath(candidate);
    if (path.resolve(String(candidate)) === selected) events.push("parent-canonical");
    return canonical;
  });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((candidate, options) => {
    const pathname = path.resolve(String(candidate));
    if (pathname === target) {
      targetLookups += 1;
      if (targetLookups === 1) {
        expect(events).toContain("parent-canonical");
        events.push("target-failure");
        changed = parentChanges;
        throw failure;
      }
    }
    const stat = rawLstat(candidate, options as never);
    if (pathname !== selected) return stat;
    events.push(changed ? "parent-changed" : "parent-current");
    return Object.assign(Object.create(stat), typeof stat.dev === "bigint"
      ? { dev: 7n, ino: changed ? 13n : 11n }
      : { dev: 7, ino: changed ? 13 : 11 });
  });
  const observeDirectory = vi.fn((pathname: string) => {
    expect(pathname).toBe(selected);
    if (backend === "native-unavailable") {
      throw Object.assign(new Error("optional observation unavailable"), { code: "ENOSYS" });
    }
    events.push(changed ? "parent-changed" : "parent-current");
    events.push("parent-canonical");
    return { dev: 7n, ino: changed ? 13n : 11n, realPath: selected };
  });
  __setNativeLoaderForTest(() => ({ observeDirectory, closeOwnedFd: vi.fn() } as unknown as NativeBinding));
  configureFsSafeNative({ mode: backend === "off" ? "off" : "require" });

  return {
    capability,
    failure,
    assertObserved() {
      expect(targetLookups).toBe(1);
      const failureIndex = events.indexOf("target-failure");
      expect(failureIndex).toBeGreaterThan(0);
      expect(events.slice(failureIndex + 1))
        .toContain(parentChanges ? "parent-changed" : "parent-current");
      expect(observeDirectory).toHaveBeenCalledTimes(
        backend === "off" ? 0 : backend === "native-unavailable" ? 1 : 2,
      );
      expect(getFsSafeTestHooks()).toBeUndefined();
    },
  };
}

for (const backend of backends) {
  it.each(["stat", "exists"] as const)(
    `preserves ordinary missing %s after checking the admitted parent (${backend})`,
    async operation => {
      const fixture = await scriptedLookup(backend, "ENOENT", false, false);
      const result = fixture.capability[operation]("selected/value");
      if (operation === "exists") await expect(result).resolves.toBe(false);
      else await expect(result).rejects.toMatchObject({ code: "not-found", cause: fixture.failure });
      fixture.assertObserved();
    },
  );

  it.each(["ENOENT", "ENOTDIR"] as const)(
    `retains ordinary %s classification with an unchanged parent (${backend})`,
    async code => {
      const fixture = await scriptedLookup(backend, code, false, true);
      await expect(fixture.capability.stat("selected/value"))
        .rejects.toMatchObject({ code: "not-found", cause: fixture.failure });
      fixture.assertObserved();
    },
  );

  for (const targetExists of [false, true]) {
    it.each(["ENOENT", "ENOTDIR"] as const)(
      `rejects changed-parent %s instead of re-admitting missing/metadata (backend=${backend}, target=${targetExists})`,
      async code => {
        const fixture = await scriptedLookup(backend, code, true, targetExists);
        await expect(fixture.capability.stat("selected/value"))
          .rejects.toMatchObject({ code: "path-mismatch" });
        fixture.assertObserved();
      },
    );
  }

  it(`does not translate a changed-parent failure into exists=false (${backend})`, async () => {
    const fixture = await scriptedLookup(backend, "ENOENT", true, false);
    await expect(fixture.capability.exists("selected/value"))
      .rejects.toMatchObject({ code: "path-mismatch" });
    fixture.assertObserved();
  });

  it.each([false, true])(
    `checks the parent before preserving a non-missing traversal error (${backend}, changed=%s)`,
    async changed => {
      const fixture = await scriptedLookup(backend, "EACCES", changed, true);
      await expect(fixture.capability.stat("selected/value")).rejects.toMatchObject(changed
        ? { code: "path-mismatch" }
        : { code: "path-alias", cause: fixture.failure });
      fixture.assertObserved();
    },
  );
}
