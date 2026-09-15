import type { BigIntStats, Stats } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fileObservation } from "../src/file-observation.js";
import { inspectStatObservationSync } from "../src/stat-observation.js";

const numeric = (dev = 7, ino = 11): Stats => ({ dev, ino, size: 3, mtimeMs: 1.25 }) as Stats;
const exact = (dev = 7n, ino = 11n): BigIntStats => ({ dev, ino, size: 3n, mtimeNs: 1250000n }) as BigIntStats;

describe("ordinary metadata with exact receipt identities", () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])("converts safe boundary %s without another observation", value => {
    const stat = numeric(value, value);
    const inspect = vi.fn(() => stat);
    const receipt = inspectStatObservationSync(inspect, { dev: BigInt(value), ino: BigInt(value) }, undefined, "linux");
    expect(receipt).toEqual({ stat, identity: { dev: BigInt(value), ino: BigInt(value) } });
    expect(receipt.stat).toBe(stat);
    expect(receipt.stat.mtimeMs).toBe(1.25);
    expect(inspect.mock.calls).toEqual([[false]]);
  });

  it.each(["dev", "ino"] as const)("compares safe expected %s exactly", field => {
    const inspect = vi.fn(() => numeric());
    const observation = fileObservation();
    let failure: unknown;
    observation.run(() => {
      try {
        inspectStatObservationSync(inspect, { dev: 7n, ino: 11n, [field]: 12n }, undefined, "linux");
      } catch (error) { failure = error; }
    });
    expect(failure).toMatchObject({ code: "path-mismatch" });
    expect(observation.has(failure, "identity")).toBe(true);
    expect(inspect.mock.calls).toEqual([[false]]);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, NaN, Infinity])(
    "promotes uncertain numeric component %s and returns the exact observation metadata", value => {
      const precise = exact(7n, 9007199254740993n);
      const inspect = vi.fn(bigint => bigint ? precise : numeric(7, value));
      const receipt = inspectStatObservationSync(inspect, undefined, undefined, "linux");
      expect(receipt.stat).toBe(precise);
      expect(receipt.identity).toEqual({ dev: 7n, ino: 9007199254740993n });
      expect(inspect.mock.calls).toEqual([[false], [true]]);
    },
  );

  it.each(["dev", "ino"] as const)("retains known %s bits across promotion", field => {
    const first = field === "dev" ? numeric(7, NaN) : numeric(NaN, 11);
    const next = field === "dev" ? exact(8n, 11n) : exact(7n, 12n);
    const inspect = vi.fn(bigint => bigint ? next : first);
    expect(() => inspectStatObservationSync(inspect, undefined, undefined, "linux"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[false], [true]]);
  });

  it("fails on a definite mismatch before promoting the unknown component", () => {
    const inspect = vi.fn(() => numeric(8, NaN));
    expect(() => inspectStatObservationSync(inspect, { dev: 7n, ino: 11n }, undefined, "linux"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[false]]);
  });

  it("retains a supplied numeric observation when an unsafe expected ID requires promotion", () => {
    const inspect = vi.fn(() => exact(8n, 9007199254740993n));
    expect(() => inspectStatObservationSync(inspect,
      { dev: 7n, ino: 9007199254740993n }, numeric(7, 9007199254740992), "linux"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[true]]);
  });

  it("distinguishes unsafe identities with the same numeric projection", () => {
    const expected = { dev: 7n, ino: 9007199254740992n };
    const changed = exact(7n, expected.ino + 1n);
    expect(Number(expected.ino)).toBe(Number(changed.ino));
    const inspect = vi.fn(() => changed);
    expect(() => inspectStatObservationSync(inspect, expected, undefined, "linux"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[true]]);
  });

  it("starts with bigint metadata when the expected identity is unsafe", () => {
    const stat = exact(9007199254740993n, 11n);
    const inspect = vi.fn(() => stat);
    expect(inspectStatObservationSync(inspect, stat, undefined, "linux").stat).toBe(stat);
    expect(inspect.mock.calls).toEqual([[true]]);
  });

  it("does not promote or retry a filesystem error", () => {
    const failure = Object.assign(new Error("observation denied"), { code: "EACCES" });
    const inspect = vi.fn(() => { throw failure; });
    expect(() => inspectStatObservationSync(inspect, undefined, undefined, "linux")).toThrow(failure);
    expect(inspect.mock.calls).toEqual([[false]]);
  });
});

describe("Windows receipt identity admission", () => {
  it("uses only bigint metadata for a known match", () => {
    const stat = exact();
    const inspect = vi.fn(() => stat);
    expect(inspectStatObservationSync(inspect, stat, undefined, "win32").stat).toBe(stat);
    expect(inspect.mock.calls).toEqual([[true]]);
  });

  it.each(["dev", "ino"] as const)("retries a transient unknown %s exactly once", field => {
    const stat = exact();
    const inspect = vi.fn().mockReturnValueOnce({ ...stat, [field]: 0n }).mockReturnValue(stat);
    expect(inspectStatObservationSync(inspect, stat, undefined, "win32").stat).toBe(stat);
    expect(inspect.mock.calls).toEqual([[true], [true]]);
  });

  it.each(["persistent", "alternating", "changed known component"])("rejects %s within the retry bound", scenario => {
    const first = exact(0n, 11n);
    const second = scenario === "persistent" ? first : scenario === "alternating" ? exact(7n, 0n) : exact(7n, 12n);
    const inspect = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    expect(() => inspectStatObservationSync(inspect, undefined, undefined, "win32"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[true], [true]]);
  });

  it("does not retry a known mismatch alongside an unknown component", () => {
    const inspect = vi.fn(() => exact(0n, 12n));
    expect(() => inspectStatObservationSync(inspect, exact(), undefined, "win32"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[true]]);
  });

  it("rejects unknown expected identity before observing", () => {
    const inspect = vi.fn(() => exact());
    expect(() => inspectStatObservationSync(inspect, exact(0n), undefined, "win32"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect).not.toHaveBeenCalled();
  });

  it("counts the supplied first bigint observation toward the two-observation bound", () => {
    const inspect = vi.fn(() => exact(0n));
    expect(() => inspectStatObservationSync(inspect, undefined, exact(0n), "win32"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[true]]);
  });

  it("refuses numeric metadata without converting it on Windows", () => {
    const inspect = vi.fn(() => numeric());
    expect(() => inspectStatObservationSync(inspect, undefined, undefined, "win32"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(inspect.mock.calls).toEqual([[true]]);
  });

  it("preserves a filesystem failure on the Windows retry", () => {
    const failure = Object.assign(new Error("observation denied"), { code: "EACCES" });
    const inspect = vi.fn().mockReturnValueOnce(exact(0n)).mockImplementation(() => { throw failure; });
    expect(() => inspectStatObservationSync(inspect, undefined, undefined, "win32")).toThrow(failure);
    expect(inspect.mock.calls).toEqual([[true], [true]]);
  });
});
