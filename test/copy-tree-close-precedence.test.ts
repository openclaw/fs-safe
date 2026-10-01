import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { copyTree, createCloneSource, probeTreeClone } from "../src/copy.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import {
  FALSY_FAILURES, noFailure, fails, pathKey, capture, expectFailure,
  observeFileHandles, observeDirectoryCloses, portableRoles, fakeNative,
} from "./helpers/copy-close-precedence.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  configureFsSafeNative({ mode: "auto" });
});

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

  describe("wrapper close precedence", () => {
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

    it.each([
      { label: "falsy close failures", rows: FALSY_FAILURES.map(value => ({ operation: noFailure, close: value })) },
      { label: "Error success/failure controls", rows: [noFailure, fails(Object.assign(new Error("clone-source operation failed"), { code: "ECLONE" }))]
        .map(operation => ({ operation, close: Object.assign(new Error("clone-source parent close failed"), { code: "ECLOSE" }) })) },
    ])("settles clone-source creation with $label", async ({ rows }) => {
      for (const [index, { operation, close }] of rows.entries()) {
        const directory = await tempRoot(`fs-safe-clone-source-close-${index}-`);
        const destination = path.join(directory, "source");
        __setNativeLoaderForTest(() => fakeNative(() => "xfs", async () => {
          if (operation.enabled) throw operation.value;
          await fsp.mkdir(destination);
        }));
        configureFsSafeNative({ mode: "auto" });
        const closes = observeDirectoryCloses([
          { label: "parent", path: directory, failure: fails(close) },
        ]);
        const settlement = await capture(() => createCloneSource(destination));
        expectFailure(settlement, operation.enabled ? operation.value : close);
        expect(closes.attempts("parent")).toBe(1);
        expect(fsSync.existsSync(destination)).toBe(!operation.enabled);
        vi.restoreAllMocks();
        __resetNativeLoaderForTest();
      }
    });

    it.each([
      { label: "Error success/failure controls", rows: [noFailure, fails(Object.assign(new Error("probe failed"), { code: "EPROBE" }))],
        close: Object.assign(new Error("probe close failed"), { code: "ECLOSE" }) },
      { label: "falsy operation failures", rows: FALSY_FAILURES.map(fails), close: new Error("probe close failed") },
    ])("settles probeTreeClone with $label", async ({ rows, close }) => {
      for (const [index, operation] of rows.entries()) {
        const directory = await tempRoot(`fs-safe-probe-close-${index}-`);
        __setNativeLoaderForTest(() => fakeNative(() => {
          if (operation.enabled) throw operation.value;
          return "xfs";
        }, async () => {}));
        configureFsSafeNative({ mode: "auto" });
        const closes = observeDirectoryCloses([
          { label: "parent", path: directory, failure: fails(close) },
        ]);
        const settlement = await capture(async () => probeTreeClone(directory));
        expectFailure(settlement, operation.enabled ? operation.value : close);
        expect(closes.attempts("parent")).toBe(1);
        vi.restoreAllMocks();
        __resetNativeLoaderForTest();
      }
    });
  });
});
