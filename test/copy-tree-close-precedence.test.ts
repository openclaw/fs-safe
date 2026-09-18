import fsSync from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree } from "../src/copy.js";
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
type FileOperation =
  | { kind: "identity" }
  | { kind: "write" | "metadata"; value: unknown };

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

function bindHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

async function fixture(label: string, names = ["payload"]) {
  const directory = await tempRoot(`fs-safe-copy-close-${label}-`);
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  await fsp.mkdir(source);
  for (const [index, name] of names.entries()) {
    await fsp.writeFile(path.join(source, name), Buffer.alloc(4097 + index, index + 1));
  }
  return { directory, source, destination };
}

type FilePlan = {
  path: string;
  operation?: FileOperation;
  closeFailure?: Failure | (() => Failure);
  beforeClose?(): Promise<void>;
  onCloseStart?(): void;
  onClosed?(): void;
};

function observeFileHandles(plans: FilePlan[]) {
  const byPath = new Map(plans.map(plan => [pathKey(plan.path), plan]));
  const attempts = new Map<string, number>();
  const events: string[] = [];
  const open = fsp.open.bind(fsp);
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const plan = byPath.get(pathKey(args[0]));
    if (!plan) return handle;
    const overrides: Partial<FileHandle> = {};
    const operation = plan.operation;
    if (operation?.kind === "identity") {
      overrides.stat = (async () => {
        const stat = await handle.stat({ bigint: true });
        return new Proxy(stat, {
          get(target, property) {
            if (property === "ino") return target.ino + 1n;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as FileHandle["stat"];
    } else if (operation?.kind === "write") {
      overrides.write = (async () => {
        throw operation.value;
      }) as FileHandle["write"];
    } else if (operation?.kind === "metadata") {
      overrides.utimes = async () => {
        throw operation.value;
      };
    }
    overrides.close = async () => {
      const key = pathKey(plan.path);
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      events.push(key);
      plan.onCloseStart?.();
      await plan.beforeClose?.();
      await handle.close();
      plan.onClosed?.();
      const configuredFailure = plan.closeFailure;
      const failure = typeof configuredFailure === "function"
        ? configuredFailure()
        : configuredFailure ?? noFailure;
      if (failure.enabled) throw failure.value;
    };
    return bindHandle(handle, overrides);
  });
  return {
    attempts: (filename: string) => attempts.get(pathKey(filename)) ?? 0,
    events,
  };
}

type DirectoryRole = {
  label: string;
  path: string;
  occurrence: number;
  failure?: Failure;
};

function observeDirectoryCloses(roles: DirectoryRole[]) {
  const open = fsSync.openSync.bind(fsSync);
  const close = fsSync.closeSync.bind(fsSync);
  const occurrences = new Map<string, number>();
  const descriptors = new Map<number, DirectoryRole>();
  const attempts = new Map<string, number>();
  const events: string[] = [];
  vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
    const fd = open(...args);
    descriptors.delete(fd);
    const key = pathKey(args[0]);
    const matching = roles.filter(role => pathKey(role.path) === key);
    if (matching.length > 0) {
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      const role = matching.find(candidate => candidate.occurrence === occurrence);
      if (role) descriptors.set(fd, role);
    }
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

function portableRoles(
  directory: string,
  source: string,
  destination: string,
  failures: Partial<Record<string, Failure>> = {},
): DirectoryRole[] {
  return [
    { label: "parent", path: directory, occurrence: 1, failure: failures.parent },
    { label: "wrapper-original", path: source, occurrence: 1, failure: failures["wrapper-original"] },
    { label: "portable-target", path: destination, occurrence: 1, failure: failures["portable-target"] },
    { label: "portable-original", path: source, occurrence: 2, failure: failures["portable-original"] },
  ];
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

describe("copyTree close precedence", () => {
  it.each([false, true])("orders cancellation during close after an earlier write failure=%s", async failedWrite => {
    const { source, destination } = await fixture(`cancel-close-${failedWrite}`);
    const sourceFile = path.join(source, "payload");
    const destinationFile = path.join(destination, "payload");
    const controller = new AbortController();
    const writeFailure = new Error("write failed first");
    const cancellation = new Error("cancelled while closing");
    const observed = observeFileHandles([
      { path: sourceFile },
      {
        path: destinationFile,
        operation: failedWrite ? { kind: "write", value: writeFailure } : undefined,
        onCloseStart: () => controller.abort(cancellation),
        closeFailure: fails(new Error("close failed last")),
      },
    ]);
    const settlement = await capture(() => copyTree(source, destination, {
      clone: "never", signal: controller.signal,
    }));
    expectFailure(settlement, failedWrite ? writeFailure : cancellation);
    expect(observed.attempts(destinationFile)).toBe(1);
    expect(observed.attempts(sourceFile)).toBe(1);
  });

  it("reports output, input, and first-of-both close failures after a successful file copy", async () => {
    const variants = [
      { output: fails(Object.assign(new Error("output close failed"), { code: "EOUTPUT" })), input: noFailure, expected: "output" },
      { output: noFailure, input: fails(Object.assign(new Error("input close failed"), { code: "EINPUT" })), expected: "input" },
      { output: fails(Object.assign(new Error("first close failed"), { code: "EFIRST" })), input: fails(Object.assign(new Error("second close failed"), { code: "ESECOND" })), expected: "output" },
    ];
    for (const [index, variant] of variants.entries()) {
      const { source, destination } = await fixture(`file-${index}`);
      const sourceFile = path.join(source, "payload");
      const destinationFile = path.join(destination, "payload");
      const observed = observeFileHandles([
        { path: sourceFile, closeFailure: variant.input },
        { path: destinationFile, closeFailure: variant.output },
      ]);
      const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
      const expected = variant.expected === "output" ? variant.output : variant.input;
      expect(expected.enabled).toBe(true);
      if (expected.enabled) expectFailure(settlement, expected.value);
      expect(observed.attempts(destinationFile)).toBe(1);
      expect(observed.attempts(sourceFile)).toBe(1);
      expect(observed.events).toEqual([pathKey(destinationFile), pathKey(sourceFile)]);
      expect(await fsp.readFile(destinationFile)).toEqual(await fsp.readFile(sourceFile));
      vi.restoreAllMocks();
    }
  });

  it("preserves file identity, write, and metadata failures over every acquired close", async () => {
    for (const kind of ["identity", "write", "metadata"] as const) {
      const { source, destination } = await fixture(`file-body-${kind}`);
      const sourceFile = path.join(source, "payload");
      const destinationFile = path.join(destination, "payload");
      const operationFailure = Object.assign(new Error(`${kind} failed`), { code: `E${kind.toUpperCase()}` });
      const observed = observeFileHandles([
        {
          path: sourceFile,
          operation: kind === "identity" ? { kind } : undefined,
          closeFailure: fails(Object.assign(new Error("input close failed"), { code: "EINPUT" })),
        },
        {
          path: destinationFile,
          operation: kind === "identity" ? undefined : { kind, value: operationFailure },
          closeFailure: fails(Object.assign(new Error("output close failed"), { code: "EOUTPUT" })),
        },
      ]);
      const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
      if (kind === "identity") {
        expect(settlement.failed && settlement.value).toMatchObject({ code: "path-mismatch" });
        expect(observed.attempts(destinationFile)).toBe(0);
      } else {
        expectFailure(settlement, operationFailure);
        expect(observed.attempts(destinationFile)).toBe(1);
      }
      expect(observed.attempts(sourceFile)).toBe(1);
      expect(await fsp.readFile(sourceFile)).toEqual(Buffer.alloc(4097, 1));
      vi.restoreAllMocks();
    }
  });

  it("preserves every falsy write rejection over close failures without reporting success", async () => {
    for (const [index, operationFailure] of FALSY_FAILURES.entries()) {
      const { source, destination } = await fixture(`falsy-body-${index}`);
      const sourceFile = path.join(source, "payload");
      const destinationFile = path.join(destination, "payload");
      const observed = observeFileHandles([
        { path: sourceFile, closeFailure: fails(new Error("input close failed")) },
        {
          path: destinationFile,
          operation: { kind: "write", value: operationFailure },
          closeFailure: fails(new Error("output close failed")),
        },
      ]);
      const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
      expectFailure(settlement, operationFailure);
      expect(observed.attempts(sourceFile)).toBe(1);
      expect(observed.attempts(destinationFile)).toBe(1);
      vi.restoreAllMocks();
    }
  });

  it("reports every falsy close rejection after an otherwise successful public copy", async () => {
    for (const [index, closeFailure] of FALSY_FAILURES.entries()) {
      const { source, destination } = await fixture(`falsy-close-${index}`);
      const sourceFile = path.join(source, "payload");
      const destinationFile = path.join(destination, "payload");
      const observed = observeFileHandles([
        { path: sourceFile },
        { path: destinationFile, closeFailure: fails(closeFailure) },
      ]);
      const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
      expectFailure(settlement, closeFailure);
      expect(observed.attempts(sourceFile)).toBe(1);
      expect(observed.attempts(destinationFile)).toBe(1);
      expect(await fsp.readFile(destinationFile)).toEqual(await fsp.readFile(sourceFile));
      vi.restoreAllMocks();
    }
  });

  it.each(["identity", "metadata"] as const)(
    "records directory %s failure before original and target close failures",
    async (kind) => {
      const { directory, source, destination } = await fixture(`directory-${kind}`);
      const sourceFile = path.join(source, "payload");
      const destinationFile = path.join(destination, "payload");
      const operationFailure = Object.assign(new Error(`directory ${kind} failed`), {
        code: kind === "identity" ? "EIDENTITY" : "EMETADATA",
      });
      let inputClosed = false;
      observeFileHandles([
        { path: sourceFile, onClosed: () => { inputClosed = true; } },
        { path: destinationFile },
      ]);
      const directories = observeDirectoryCloses(portableRoles(directory, source, destination, {
        "portable-original": fails(Object.assign(new Error("original close failed"), { code: "EORIGINAL" })),
        "portable-target": fails(Object.assign(new Error("target close failed"), { code: "ETARGET" })),
      }));
      if (kind === "identity") {
        const lstat = fsSync.lstatSync.bind(fsSync);
        let injected = false;
        vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args) => {
          if (!injected && inputClosed && pathKey(args[0]) === pathKey(source)) {
            injected = true;
            throw operationFailure;
          }
          return lstat(...args);
        }) as typeof fsSync.lstatSync);
      } else {
        const utimes = fsp.utimes.bind(fsp);
        vi.spyOn(fsp, "utimes").mockImplementation(async (...args) => {
          if (pathKey(args[0]) === pathKey(destination)) throw operationFailure;
          return await utimes(...args);
        });
      }
      const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
      expectFailure(settlement, operationFailure);
      expect(directories.attempts("portable-original")).toBe(1);
      expect(directories.attempts("portable-target")).toBe(1);
      expect(directories.events).toEqual([
        "portable-original", "portable-target", "wrapper-original", "parent",
      ]);
      expect(await fsp.readFile(destinationFile)).toEqual(await fsp.readFile(sourceFile));
    },
  );

  it("reports the original-directory close before the target close after successful completion", async () => {
    const { directory, source, destination } = await fixture("directory-close-only");
    const originalFailure = Object.assign(new Error("original close failed"), { code: "EORIGINAL" });
    const directories = observeDirectoryCloses(portableRoles(directory, source, destination, {
      "portable-original": fails(originalFailure),
      "portable-target": fails(Object.assign(new Error("target close failed"), { code: "ETARGET" })),
    }));
    const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
    expectFailure(settlement, originalFailure);
    expect(directories.attempts("portable-original")).toBe(1);
    expect(directories.attempts("portable-target")).toBe(1);
    expect(directories.events.slice(0, 2)).toEqual(["portable-original", "portable-target"]);
  });

  it("reports the wrapper original close before parent close after a successful portable copy", async () => {
    const { directory, source, destination } = await fixture("wrapper-close-only");
    const originalFailure = Object.assign(new Error("wrapper original close failed"), { code: "EORIGINAL" });
    const directories = observeDirectoryCloses(portableRoles(directory, source, destination, {
      "wrapper-original": fails(originalFailure),
      parent: fails(Object.assign(new Error("parent close failed"), { code: "EPARENT" })),
    }));
    const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
    expectFailure(settlement, originalFailure);
    for (const label of ["portable-original", "portable-target", "wrapper-original", "parent"]) {
      expect(directories.attempts(label)).toBe(1);
    }
    expect(directories.events.slice(-2)).toEqual(["wrapper-original", "parent"]);
  });

  it("preserves a portable failure over wrapper original and parent closes", async () => {
    const { directory, source, destination } = await fixture("wrapper-portable-failure");
    const sourceFile = path.join(source, "payload");
    const destinationFile = path.join(destination, "payload");
    const operationFailure = Object.assign(new Error("portable write failed"), { code: "EWRITE" });
    observeFileHandles([
      { path: sourceFile },
      { path: destinationFile, operation: { kind: "write", value: operationFailure } },
    ]);
    const directories = observeDirectoryCloses(portableRoles(directory, source, destination, {
      "wrapper-original": fails(Object.assign(new Error("original close failed"), { code: "EORIGINAL" })),
      parent: fails(Object.assign(new Error("parent close failed"), { code: "EPARENT" })),
    }));
    const settlement = await capture(() => copyTree(source, destination, { clone: "never" }));
    expectFailure(settlement, operationFailure);
    expect(directories.attempts("wrapper-original")).toBe(1);
    expect(directories.attempts("parent")).toBe(1);
  });

  it("preserves native copy failure over wrapper original and parent closes", async () => {
    const { directory, source, destination } = await fixture("wrapper-native-failure");
    const operationFailure = Object.assign(new Error("native clone failed"), { code: "EIO" });
    __setNativeLoaderForTest(() => fakeNative(() => "xfs", async () => {
      throw operationFailure;
    }));
    configureFsSafeNative({ mode: "auto" });
    const directories = observeDirectoryCloses([
      { label: "parent", path: directory, occurrence: 1, failure: fails(new Error("parent close failed")) },
      { label: "wrapper-original", path: source, occurrence: 1, failure: fails(new Error("original close failed")) },
    ]);
    const settlement = await capture(() => copyTree(source, destination, { clone: "always" }));
    expectFailure(settlement, operationFailure);
    expect(directories.events).toEqual(["wrapper-original", "parent"]);
  });

  it("settles two admitted files and closes every handle and directory once", async () => {
    const { directory, source, destination } = await fixture("concurrency", ["a", "b"]);
    const release = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const secondFailed = Promise.withResolvers<string>();
    const firstFailure = new Error("first output close failed after release");
    const observedFailure = new Error("second output close failed first");
    let closeOrder = 0;
    const files = ["a", "b"].flatMap((name) => {
      const input = path.join(source, name);
      const output = path.join(destination, name);
      let order = 0;
      return [
        { path: input },
        {
          path: output,
          closeFailure: () => {
            if (order === 2) secondFailed.resolve(name);
            return fails(order === 1 ? firstFailure : observedFailure);
          },
          beforeClose: async () => {
            order = ++closeOrder;
            if (order === 1) {
              firstEntered.resolve();
              await release.promise;
            }
          },
        },
      ];
    });
    const handles = observeFileHandles(files);
    const directories = observeDirectoryCloses(portableRoles(directory, source, destination));
    let settled = false;
    const pending = capture(() => copyTree(source, destination, {
      clone: "never",
      concurrency: 2,
    })).then((result) => {
      settled = true;
      return result;
    });
    await firstEntered.promise;
    const secondName = await secondFailed.promise;
    await vi.waitFor(() => {
      expect(handles.attempts(path.join(destination, secondName))).toBe(1);
      expect(handles.attempts(path.join(source, secondName))).toBe(1);
    });
    expect(settled).toBe(false);
    release.resolve();
    const settlement = await pending;
    expectFailure(settlement, observedFailure);
    for (const name of ["a", "b"]) {
      expect(handles.attempts(path.join(source, name))).toBe(1);
      expect(handles.attempts(path.join(destination, name))).toBe(1);
      expect(await fsp.readFile(path.join(destination, name))).toEqual(
        await fsp.readFile(path.join(source, name)),
      );
    }
    for (const label of ["portable-original", "portable-target", "wrapper-original", "parent"]) {
      expect(directories.attempts(label)).toBe(1);
    }
  });
});
