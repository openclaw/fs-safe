import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRemovalDirectoryCurrent,
  createRemovalDirectoryAssertion,
} from "../src/root-remove-identity.js";

type Observation = Stats | BigIntStats;

function directoryObservation(
  dev: number | bigint,
  ino: number | bigint,
  kind: "directory" | "file" | "symlink" = "directory",
): Observation {
  return {
    dev,
    ino,
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  } as unknown as Observation;
}

function mockLstat(...results: readonly (Observation | Error | object)[]) {
  const calls: Parameters<typeof fsSync.lstatSync>[] = [];
  let index = 0;
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    calls.push(args);
    const result = results[index++];
    if (result instanceof Error) throw result;
    return result as Stats;
  }) as typeof fsSync.lstatSync);
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe("nonrecursive removal identity assertions", () => {
  it.each(["linux", "win32"] as const)("uses one numeric observation for safe known IDs on %s", platform => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, platform);
    const calls = mockLstat(directoryObservation(11, 22));

    expect(() => assertRemovalDirectoryCurrent(assertion)).not.toThrow();
    expect(calls).toEqual([["boundary"]]);
  });

  it("treats zero as a known safe identity outside Windows", () => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 0n, ino: 0n }, undefined, "linux");
    const calls = mockLstat(directoryObservation(0, 0));

    expect(() => assertRemovalDirectoryCurrent(assertion)).not.toThrow();
    expect(calls).toEqual([["boundary"]]);
  });

  it.each([
    { name: "device mismatch", dev: 12, ino: 22 },
    { name: "inode mismatch", dev: 11, ino: 23 },
    { name: "negative device", dev: -1, ino: 22 },
    { name: "negative inode", dev: 11, ino: -1 },
    { name: "fractional", dev: 11.5, ino: 22 },
    { name: "nonfinite", dev: Number.POSITIVE_INFINITY, ino: 22 },
    { name: "unsafe", dev: Number.MAX_SAFE_INTEGER + 1, ino: 22 },
    { name: "nonnumeric", dev: "11", ino: 22 },
  ])("fails closed on a malformed or changed numeric observation: $name", ({ dev, ino }) => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, "linux");
    const calls = mockLstat(directoryObservation(dev as number, ino));

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(calls).toHaveLength(1);
  });

  it.each(["file", "symlink"] as const)("rejects a replacement $kind before identity acceptance", kind => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, "linux");
    const calls = mockLstat(directoryObservation(11, 22, kind));

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow(expect.objectContaining({ code: "not-file" }));
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed stat shape", () => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, "linux");
    const calls = mockLstat({ dev: 11, ino: 22 });

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(calls).toHaveLength(1);
  });

  it.each([
    { name: "large device", dev: BigInt(Number.MAX_SAFE_INTEGER) + 1n, ino: 22n },
    { name: "large inode", dev: 11n, ino: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    { name: "negative", dev: -1n, ino: 22n },
  ])("retains exact bigint assertions for an unsafe expected $name", ({ dev, ino }) => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev, ino }, undefined, "linux");
    const calls = mockLstat(directoryObservation(dev, ino));

    expect(assertion.numericDev).toBeUndefined();
    expect(assertion.numericIno).toBeUndefined();
    expect(() => assertRemovalDirectoryCurrent(assertion)).not.toThrow();
    expect(calls).toEqual([["boundary", { bigint: true }]]);
  });

  it("rejects a mismatch on the unsafe exact path", () => {
    const dev = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const assertion = createRemovalDirectoryAssertion("boundary", { dev, ino: 22n }, undefined, "linux");
    const calls = mockLstat(directoryObservation(dev + 1n, 22n));

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(calls).toEqual([["boundary", { bigint: true }]]);
  });

  it("rejects an unknown Windows admission identity without observing the path", () => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 0n, ino: 22n }, undefined, "win32");
    const calls = mockLstat(directoryObservation(11n, 22n));

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(calls).toHaveLength(0);
  });

  it.each(["dev", "ino"] as const)("promotes one unknown Windows numeric $field exactly once", field => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, "win32");
    const numeric = field === "dev" ? directoryObservation(0, 22) : directoryObservation(11, 0);
    const calls = mockLstat(numeric, directoryObservation(11n, 22n));

    expect(() => assertRemovalDirectoryCurrent(assertion)).not.toThrow();
    expect(calls).toEqual([["boundary"], ["boundary", { bigint: true }]]);
  });

  it("rejects a known Windows mismatch without spending the exact retry", () => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, "win32");
    const calls = mockLstat(directoryObservation(0, 23), directoryObservation(11n, 22n));

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(calls).toHaveLength(1);
  });

  it.each([
    { name: "persistent zero", exact: directoryObservation(0n, 22n) },
    { name: "alternating zero", exact: directoryObservation(11n, 0n) },
    { name: "changed exact identity", exact: directoryObservation(11n, 23n) },
    { name: "numeric exact response", exact: directoryObservation(11, 22) },
    { name: "malformed exact response", exact: { dev: 11n, ino: 22n } },
  ])("fails closed after one Windows exact retry: $name", ({ exact }) => {
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, "win32");
    const calls = mockLstat(directoryObservation(0, 22), exact);

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow();
    expect(calls).toEqual([["boundary"], ["boundary", { bigint: true }]]);
  });

  it.each(["numeric", "exact"] as const)("does not retry a Windows $phase observation error", phase => {
    const failure = Object.assign(new Error(`${phase} blocked`), { code: "EACCES" });
    const assertion = createRemovalDirectoryAssertion("boundary", { dev: 11n, ino: 22n }, undefined, "win32");
    const calls = phase === "numeric"
      ? mockLstat(failure)
      : mockLstat(directoryObservation(0, 22), failure);

    expect(() => assertRemovalDirectoryCurrent(assertion)).toThrow(failure);
    expect(calls).toHaveLength(phase === "numeric" ? 1 : 2);
  });
});
