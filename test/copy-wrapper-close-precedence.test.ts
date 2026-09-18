import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree, createCloneSource, probeTreeClone } from "../src/copy.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const FALSY_FAILURES = [undefined, null, false, 0, -0, 0n, "", Number.NaN] as const;

type Failure = { enabled: true; value: unknown } | { enabled: false };
type Settlement = { failed: true; value: unknown } | { failed: false };

const noFailure: Failure = { enabled: false };
const fails = (value: unknown): Failure => ({ enabled: true, value });

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  configureFsSafeNative({ mode: "auto" });
});

function pathKey(value: fsSync.PathLike): string {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function capture(run: () => Promise<unknown>): Promise<Settlement> {
  try {
    await run();
    return { failed: false };
  } catch (value) {
    return { failed: true, value };
  }
}

function expectFailure(settlement: Settlement, expected: unknown): void {
  expect(settlement.failed).toBe(true);
  if (settlement.failed) expect(Object.is(settlement.value, expected)).toBe(true);
}

function observeDirectoryCloses(
  roles: Array<{ label: string; path: string; failure?: Failure }>,
) {
  const open = fsSync.openSync.bind(fsSync);
  const close = fsSync.closeSync.bind(fsSync);
  const byPath = new Map(roles.map(role => [pathKey(role.path), role]));
  const descriptors = new Map<number, (typeof roles)[number]>();
  const attempts = new Map<string, number>();
  const events: string[] = [];
  vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
    const fd = open(...args);
    descriptors.delete(fd);
    const role = byPath.get(pathKey(args[0]));
    if (role) descriptors.set(fd, role);
    return fd;
  }) as typeof fsSync.openSync);
  vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    const role = descriptors.get(fd);
    if (role) {
      attempts.set(role.label, (attempts.get(role.label) ?? 0) + 1);
      events.push(role.label);
    }
    close(fd);
    if (!role) return;
    const failure = role.failure ?? noFailure;
    if (failure.enabled) throw failure.value;
  });
  return {
    attempts: (label: string) => attempts.get(label) ?? 0,
    events,
  };
}

function fakeNative(
  probe: NativeBinding["probeTreeClone"],
  clone: NativeBinding["cloneTree"],
): NativeBinding {
  return {
    closeOwnedFd() {},
    probeTreeClone: probe,
    cloneTree: clone,
  } as NativeBinding;
}

describe("copy wrapper close precedence", () => {
  it("preserves every falsy native copy failure over wrapper closes", async () => {
    for (const [index, operationFailure] of FALSY_FAILURES.entries()) {
      const directory = await tempRoot(`fs-safe-falsy-native-${index}-`);
      const source = path.join(directory, "source");
      const destination = path.join(directory, "destination");
      await fsp.mkdir(source);
      __setNativeLoaderForTest(() => fakeNative(() => "xfs", async () => {
        throw operationFailure;
      }));
      configureFsSafeNative({ mode: "auto" });
      const closes = observeDirectoryCloses([
        { label: "parent", path: directory, failure: fails(new Error("parent close failed")) },
        { label: "original", path: source, failure: fails(new Error("original close failed")) },
      ]);
      const settlement = await capture(() => copyTree(source, destination, { clone: "always" }));
      expectFailure(settlement, operationFailure);
      expect(closes.events).toEqual(["original", "parent"]);
      vi.restoreAllMocks();
      __resetNativeLoaderForTest();
    }
  });

  it("reports every falsy parent-close failure after successful clone-source creation", async () => {
    for (const [index, closeFailure] of FALSY_FAILURES.entries()) {
      const directory = await tempRoot(`fs-safe-falsy-clone-source-close-${index}-`);
      const destination = path.join(directory, "source");
      __setNativeLoaderForTest(() => fakeNative(() => "xfs", async () => {
        await fsp.mkdir(destination);
      }));
      configureFsSafeNative({ mode: "auto" });
      const closes = observeDirectoryCloses([
        { label: "parent", path: directory, failure: fails(closeFailure) },
      ]);
      const settlement = await capture(() => createCloneSource(destination));
      expectFailure(settlement, closeFailure);
      expect(closes.attempts("parent")).toBe(1);
      expect(fsSync.existsSync(destination)).toBe(true);
      vi.restoreAllMocks();
      __resetNativeLoaderForTest();
    }
  });

  it("makes createCloneSource close-only failure reject and preserves native failure over it", async () => {
    for (const operation of ["success", "failure"] as const) {
      const directory = await tempRoot(`fs-safe-clone-source-close-${operation}-`);
      const destination = path.join(directory, "source");
      const operationFailure = Object.assign(new Error("clone-source operation failed"), { code: "ECLONE" });
      const closeFailure = Object.assign(new Error("clone-source parent close failed"), { code: "ECLOSE" });
      __setNativeLoaderForTest(() => fakeNative(() => "xfs", async () => {
        if (operation === "failure") throw operationFailure;
        await fsp.mkdir(destination);
      }));
      configureFsSafeNative({ mode: "auto" });
      const closes = observeDirectoryCloses([
        { label: "parent", path: directory, failure: fails(closeFailure) },
      ]);
      const settlement = await capture(() => createCloneSource(destination));
      expectFailure(settlement, operation === "failure" ? operationFailure : closeFailure);
      expect(closes.attempts("parent")).toBe(1);
      expect(fsSync.existsSync(destination)).toBe(operation === "success");
      vi.restoreAllMocks();
      __resetNativeLoaderForTest();
    }
  });

  it("preserves probeTreeClone failure over close and reports close after a successful probe", async () => {
    for (const operation of ["success", "failure"] as const) {
      const directory = await tempRoot(`fs-safe-probe-close-${operation}-`);
      const operationFailure = Object.assign(new Error("probe failed"), { code: "EPROBE" });
      const closeFailure = Object.assign(new Error("probe close failed"), { code: "ECLOSE" });
      __setNativeLoaderForTest(() => fakeNative(() => {
        if (operation === "failure") throw operationFailure;
        return "xfs";
      }, async () => {}));
      configureFsSafeNative({ mode: "auto" });
      const closes = observeDirectoryCloses([
        { label: "parent", path: directory, failure: fails(closeFailure) },
      ]);
      const settlement = await capture(async () => probeTreeClone(directory));
      expectFailure(settlement, operation === "failure" ? operationFailure : closeFailure);
      expect(closes.attempts("parent")).toBe(1);
      vi.restoreAllMocks();
      __resetNativeLoaderForTest();
    }
  });

  it("preserves every falsy probe failure over parent close", async () => {
    for (const [index, operationFailure] of FALSY_FAILURES.entries()) {
      const directory = await tempRoot(`fs-safe-falsy-probe-close-${index}-`);
      __setNativeLoaderForTest(() => fakeNative(() => {
        throw operationFailure;
      }, async () => {}));
      configureFsSafeNative({ mode: "auto" });
      const closes = observeDirectoryCloses([
        { label: "parent", path: directory, failure: fails(new Error("probe close failed")) },
      ]);
      const settlement = await capture(async () => probeTreeClone(directory));
      expectFailure(settlement, operationFailure);
      expect(closes.attempts("parent")).toBe(1);
      vi.restoreAllMocks();
      __resetNativeLoaderForTest();
    }
  });
});
