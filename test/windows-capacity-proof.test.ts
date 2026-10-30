import { expect, it } from "vitest";
import { assertWindowsCapacityProof } from "../scripts/windows-capacity-proof.mjs";

function proof() {
  return {
    workload: "fallback", capacity: "standard", expectedCommit: "a".repeat(40),
    source: { commit: "a".repeat(40), tree: "b".repeat(40), dirty: false },
    platform: "win32", arch: "x64", logicalProcessors: 4,
    nodeMajor: 22, expectedNodeMajor: 22, totalPhysicalBytes: 16 * 1024 ** 3,
    freePhysicalBytes: 12 * 1024 ** 3, bindings: [] as { path: string; sha256: string }[],
    nativeLoaded: false,
  };
}

it("admits exact-source fallback candidates and native controls at the observed capacity", () => {
  expect(() => assertWindowsCapacityProof(proof())).not.toThrow();
  expect(() => assertWindowsCapacityProof({ ...proof(), workload: "native", capacity: "control", logicalProcessors: 16 }))
    .not.toThrow();
});

it.each([
  ["unknown workload", { workload: "package" }],
  ["unknown capacity", { capacity: "other" }],
  ["missing expected source", { expectedCommit: undefined }],
  ["wrong source", { source: { commit: "c".repeat(40), tree: "b".repeat(40), dirty: false } }],
  ["dirty source", { source: { commit: "a".repeat(40), tree: "b".repeat(40), dirty: true } }],
  ["missing tree", { source: { commit: "a".repeat(40), dirty: false } }],
  ["non-Windows host", { platform: "linux" }],
  ["wrong architecture", { arch: "arm64" }],
  ["unexpected CPU allocation", { logicalProcessors: 8 }],
  ["wrong Node", { nodeMajor: 24 }],
  ["unsupported Node", { nodeMajor: 20, expectedNodeMajor: 20 }],
  ["missing RAM", { totalPhysicalBytes: 0 }],
  ["unexpected fallback binding", { bindings: [{ path: "native.node", sha256: "hash" }] }],
  ["native fallback", { nativeLoaded: true }],
] as const)("rejects %s instead of accepting incomplete qualification", (_label, patch) => {
  expect(() => assertWindowsCapacityProof({ ...proof(), ...patch })).toThrow();
});

it("requires original identical staged bytes and a loaded binding for coverage", () => {
  const coverage = { ...proof(), workload: "coverage", nativeLoaded: true, bindings: [
    { path: "native.node", sha256: "same" }, { path: "staged.node", sha256: "same" },
  ] };
  expect(() => assertWindowsCapacityProof(coverage)).not.toThrow();
  expect(() => assertWindowsCapacityProof({ ...coverage, bindings: [] })).toThrow();
  expect(() => assertWindowsCapacityProof({ ...coverage, nativeLoaded: false })).toThrow();
  expect(() => assertWindowsCapacityProof({ ...coverage, bindings: [coverage.bindings[0], { path: "staged.node", sha256: "different" }] }))
    .toThrow();
});
