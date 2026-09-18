import type { Stats } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  sameFileIdentityForCleanup,
  type FileIdentityStat,
} from "../src/file-identity.js";
import {
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
} from "../src/sidecar-lock-reclaim.js";

type IdentitySide = "left" | "right";
type IdentityComponent = keyof FileIdentityStat;
type Observation = `${IdentitySide}.${IdentityComponent}`;

const known = { dev: 41, ino: 73 } as const;
const observationOrder = ["left.dev", "left.ino", "right.dev", "right.ino"] as const;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const zeroRepresentations = [
  { label: "number zero", value: 0 },
  { label: "bigint zero", value: 0n },
  { label: "negative zero", value: -0 },
] as const;

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
});

function trackedIdentity(
  label: IdentitySide,
  values: FileIdentityStat,
  reads: string[],
): FileIdentityStat {
  return {
    get dev() {
      reads.push(`${label}.dev`);
      return values.dev;
    },
    get ino() {
      reads.push(`${label}.ino`);
      return values.ino;
    },
  };
}

function identityWith(
  side: IdentitySide,
  component: IdentityComponent,
  value: number | bigint,
): { left: FileIdentityStat; right: FileIdentityStat } {
  const left: FileIdentityStat = { ...known };
  const right: FileIdentityStat = { ...known };
  (side === "left" ? left : right)[component] = value;
  return { left, right };
}

function identityAtBoundary(
  component: IdentityComponent,
  value: number | bigint,
): FileIdentityStat {
  const other = typeof value === "bigint" ? BigInt(known[component === "dev" ? "ino" : "dev"])
    : known[component === "dev" ? "ino" : "dev"];
  return component === "dev" ? { dev: value, ino: other } : { dev: other, ino: value };
}

const unknownCases = observationOrder.flatMap((observation) => {
  const [side, component] = observation.split(".") as [IdentitySide, IdentityComponent];
  return zeroRepresentations.map(({ label, value }) => ({
    label: `${observation} ${label}`,
    ...identityWith(side, component, value),
  }));
});

const mixedEqualityCases = Array.from({ length: 16 }, (_, mask) => {
  const represent = (value: number, bit: number): number | bigint =>
    mask & (1 << bit) ? BigInt(value) : value;
  const label = Array.from({ length: 4 }, (_unused, bit) =>
    mask & (1 << bit) ? "bigint" : "number").join("/");
  return {
    label,
    left: { dev: represent(known.dev, 0), ino: represent(known.ino, 1) },
    right: { dev: represent(known.dev, 2), ino: represent(known.ino, 3) },
  } satisfies { label: string; left: FileIdentityStat; right: FileIdentityStat };
});

function zeroFenceIdentities(
  zeroAt: Observation,
  zero: number | bigint,
  reads: string[],
  laterRead: Error,
): { left: FileIdentityStat; right: FileIdentityStat } {
  const zeroIndex = observationOrder.indexOf(zeroAt);
  const read = (observation: Observation): number | bigint => {
    reads.push(observation);
    if (observation === zeroAt) return zero;
    if (observationOrder.indexOf(observation) > zeroIndex) throw laterRead;
    // If the last zero fence is removed, this invalid mixed device comparison
    // throws. The real fence must return before starting any conversion.
    if (zeroAt === "right.ino" && observation === "left.dev") return Number.NaN;
    if (observation === "left.dev") return known.dev;
    if (observation === "left.ino") return known.ino;
    if (observation === "right.dev") return BigInt(known.dev);
    return BigInt(known.ino);
  };
  return {
    left: {
      get dev() { return read("left.dev"); },
      get ino() { return read("left.ino"); },
    },
    right: {
      get dev() { return read("right.dev"); },
      get ino() { return read("right.ino"); },
    },
  };
}

describe("cleanup file identity", () => {
  describe("Windows unknown identity fencing", () => {
    it.each(unknownCases)("rejects $label", ({ left, right }) => {
      expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(false);
    });

    it.each(observationOrder.flatMap((zeroAt) =>
      zeroRepresentations.map(({ label, value }) => ({ zeroAt, label, value }))))(
      "requires the $zeroAt fence for $label",
      ({ zeroAt, value }) => {
        const reads: string[] = [];
        const laterRead = new Error("read after zero identity");
        const { left, right } = zeroFenceIdentities(zeroAt, value, reads, laterRead);

        let result: boolean | undefined;
        let caught: unknown;
        try {
          result = sameFileIdentityForCleanup(left, right, "win32");
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeUndefined();
        expect(result).toBe(false);
        expect(reads).toEqual(observationOrder.slice(0, observationOrder.indexOf(zeroAt) + 1));
      },
    );

    it.each(([
      ["NaN", Number.NaN],
      ["positive Infinity", Number.POSITIVE_INFINITY],
      ["negative Infinity", Number.NEGATIVE_INFINITY],
      ["fraction", 41.5],
    ] as const).flatMap(([label, invalid]) =>
      zeroRepresentations.map((zero) => ({
        label,
        invalid,
        zeroLabel: zero.label,
        zeroValue: zero.value,
      }))))(
      "rejects $zeroLabel before converting $label",
      ({ invalid, zeroValue }) => {
        expect(sameFileIdentityForCleanup(
          { dev: invalid, ino: known.ino },
          { dev: BigInt(known.dev), ino: zeroValue },
          "win32",
        )).toBe(false);
      },
    );

    it("rejects a right device zero before converting the captured device pair", () => {
      expect(sameFileIdentityForCleanup(
        { dev: Number.NaN, ino: known.ino },
        { dev: 0n, ino: BigInt(known.ino) },
        "win32",
      )).toBe(false);
    });
  });

  describe("representation and numeric boundaries", () => {
    it.each(mixedEqualityCases)(
      "accepts independent equal representations $label",
      ({ left, right }) => {
        expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(true);
      },
    );

    it.each([
      ["safe maximum", Number.MAX_SAFE_INTEGER, 9_007_199_254_740_991n, true],
      ["safe boundary mismatch", Number.MAX_SAFE_INTEGER, 9_007_199_254_740_990n, false],
      ["first unsafe exact integer", 9_007_199_254_740_992, 9_007_199_254_740_992n, true],
      ["first unsafe adjacent bigint", 9_007_199_254_740_992, 9_007_199_254_740_993n, false],
      ["next unsafe exact integer", 9_007_199_254_740_994, 9_007_199_254_740_994n, true],
      ["next unsafe adjacent bigint", 9_007_199_254_740_994, 9_007_199_254_740_995n, false],
    ] as const)("compares the %s exactly", (_label, numeric, bigint, expected) => {
      for (const component of ["dev", "ino"] as const) {
        const numericIdentity = identityAtBoundary(component, numeric);
        const bigintIdentity = identityAtBoundary(component, bigint);
        expect(sameFileIdentityForCleanup(numericIdentity, bigintIdentity, "win32")).toBe(expected);
        expect(sameFileIdentityForCleanup(bigintIdentity, numericIdentity, "win32")).toBe(expected);
      }
    });

    it.each([
      ["device", { dev: 41, ino: 73 }, { dev: 42n, ino: 73n }],
      ["inode", { dev: 41, ino: 73 }, { dev: 41n, ino: 74n }],
    ] as const)("requires the known Windows %s comparison", (_label, left, right) => {
      expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(false);
    });

    it("compares captured devices before converting captured inodes", () => {
      expect(sameFileIdentityForCleanup(
        { dev: 41, ino: Number.NaN },
        { dev: 42n, ino: 73n },
        "win32",
      )).toBe(false);
    });
  });

  describe("observation semantics", () => {
    it("captures each known Windows component once in zero-first order", () => {
      const reads: string[] = [];
      const left = trackedIdentity("left", { dev: 41, ino: 73 }, reads);
      const right = trackedIdentity("right", { dev: 41n, ino: 73n }, reads);

      expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(true);
      expect(reads).toEqual(observationOrder);
    });

    it("captures all Windows components before a known comparison mismatch", () => {
      const reads: string[] = [];
      const left = trackedIdentity("left", { dev: 41, ino: 73 }, reads);
      const right = trackedIdentity("right", { dev: 42n, ino: 73n }, reads);

      expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(false);
      expect(reads).toEqual(observationOrder);
    });

    it("does not reread changing Windows accessors", () => {
      const reads: string[] = [];
      const counts = new Map<Observation, number>();
      const changingValue = (observation: Observation, first: number | bigint): number | bigint => {
        reads.push(observation);
        const count = (counts.get(observation) ?? 0) + 1;
        counts.set(observation, count);
        return count === 1 ? first : 0;
      };
      const left: FileIdentityStat = {
        get dev() { return changingValue("left.dev", 41); },
        get ino() { return changingValue("left.ino", 73); },
      };
      const right: FileIdentityStat = {
        get dev() { return changingValue("right.dev", 41n); },
        get ino() { return changingValue("right.ino", 73n); },
      };

      expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(true);
      expect(reads).toEqual(observationOrder);
      expect([...counts.values()]).toEqual([1, 1, 1, 1]);
    });

    it("compares captured values after later getters mutate their backing adapter", () => {
      const reads: string[] = [];
      const leftValues: FileIdentityStat = { dev: 41, ino: 73 };
      const left = trackedIdentity("left", leftValues, reads);
      const right: FileIdentityStat = {
        get dev() {
          reads.push("right.dev");
          leftValues.dev = 42;
          return 41n;
        },
        get ino() {
          reads.push("right.ino");
          leftValues.ino = 74;
          return 73n;
        },
      };

      expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(true);
      expect(reads).toEqual(observationOrder);
    });

    it.each(observationOrder)("propagates a throwing %s getter in order", (zeroAt) => {
      const reads: string[] = [];
      const failure = new Error(`failed ${zeroAt}`);
      const read = (observation: Observation, value: number | bigint): number | bigint => {
        reads.push(observation);
        if (observation === zeroAt) throw failure;
        return value;
      };
      const left: FileIdentityStat = {
        get dev() { return read("left.dev", 41); },
        get ino() { return read("left.ino", 73); },
      };
      const right: FileIdentityStat = {
        get dev() { return read("right.dev", 41n); },
        get ino() { return read("right.ino", 73n); },
      };

      let caught: unknown;
      try {
        sameFileIdentityForCleanup(left, right, "win32");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(reads).toEqual(observationOrder.slice(0, observationOrder.indexOf(zeroAt) + 1));
    });

    it.each(["linux", "darwin"] as const)(
      "preserves the direct %s comparison observation order",
      (platform) => {
        const reads: string[] = [];
        const left = trackedIdentity("left", { dev: 41, ino: 73 }, reads);
        const right = trackedIdentity("right", { dev: 41n, ino: 73n }, reads);

        expect(sameFileIdentityForCleanup(left, right, platform)).toBe(true);
        expect(reads).toEqual(["left.dev", "right.dev", "left.ino", "right.ino"]);
      },
    );

    it.each(["linux", "darwin"] as const)(
      "keeps the direct %s device mismatch short circuit",
      (platform) => {
        const reads: string[] = [];
        const left = trackedIdentity("left", { dev: 41, ino: 73 }, reads);
        const right = trackedIdentity("right", { dev: 42n, ino: 73n }, reads);

        expect(sameFileIdentityForCleanup(left, right, platform)).toBe(false);
        expect(reads).toEqual(["left.dev", "right.dev"]);
      },
    );
  });

  describe("platform routing and consumer integration", () => {
    it.each([
      ["win32", false],
      ["linux", true],
      ["darwin", true],
    ] as const)("treats equal zero identities on %s as %s", (platform, expected) => {
      expect(sameFileIdentityForCleanup(
        { dev: -0, ino: 73n },
        { dev: 0n, ino: 73 },
        platform,
      )).toBe(expected);
    });

    it("uses the host default while explicit platform overrides remain authoritative", () => {
      const left = { dev: 0, ino: 73n };
      const right = { dev: 0n, ino: 73 };
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(sameFileIdentityForCleanup(left, right)).toBe(false);
      expect(sameFileIdentityForCleanup(left, right, "linux")).toBe(true);
      expect(sameFileIdentityForCleanup(left, right, "darwin")).toBe(true);

      Object.defineProperty(process, "platform", { value: "linux" });
      expect(sameFileIdentityForCleanup(left, right)).toBe(true);
      expect(sameFileIdentityForCleanup(left, right, "win32")).toBe(false);
    });

    it("keeps adapter-backed legacy sidecar cleanup fail closed", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const reads: string[] = [];
      const observed = trackedIdentity("left", { dev: 41, ino: 73 }, reads) as unknown as Stats;
      const current = trackedIdentity("right", { dev: 41n, ino: 0n }, reads) as unknown as Stats;
      const observedSnapshot: SidecarLockSnapshot = {
        payload: null,
        raw: "same legacy bytes",
        stat: observed,
      };
      const currentSnapshot: SidecarLockSnapshot = {
        payload: null,
        raw: "same legacy bytes",
        stat: current,
      };

      expect(sidecarLockSnapshotMatches(currentSnapshot, observedSnapshot)).toBe(false);
      expect(reads).toEqual(observationOrder);
    });
  });
});
