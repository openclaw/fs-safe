import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../src/file-hash.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import {
  abcHash, expectedHashOpenFlags, hashIdentity, observeHashPath,
  type HashBoundary, type HashSamples,
} from "./helpers/file-hash-identity.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const boundaries = ["preview", "descriptor", "current"] as const;
const unknowns = [
  { label: "dev", value: { dev: 0n } },
  { label: "ino", value: { ino: 0n } },
  { label: "both", value: { dev: 0n, ino: 0n } },
];

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture(samples: HashSamples = {}, mode: "off" | "mock-native" = "off") {
  const directory = await tempRoot("fs-safe-hash-identity-");
  Object.defineProperty(process, "platform", { value: "win32" });
  return await observeHashPath(directory, samples, mode);
}

function expectedCounts(boundary: HashBoundary, attempts: number, succeeds = false) {
  const stoppedAt = boundaries.indexOf(boundary);
  return Object.fromEntries(boundaries.map((stage, index) =>
    [stage, stage === boundary ? attempts : succeeds || index < stoppedAt ? 1 : 0],
  )) as Record<HashBoundary, number>;
}

function assertTrace(
  subject: Awaited<ReturnType<typeof fixture>>,
  counts: Record<HashBoundary, number>,
  hashing?: "off" | "mock-native",
) {
  expect(subject.counts).toEqual(counts);
  const opened = counts.descriptor > 0;
  const expected = [
    ...Array(counts.preview).fill("preview"),
    ...(opened ? ["open"] : []),
    ...Array(counts.descriptor).fill("descriptor"),
    ...Array(counts.current).fill("current"),
    ...(hashing ? ["hash-stat", ...(hashing === "off" ? ["read", "read"] : ["native"])] : []),
    ...(opened ? ["close"] : []),
  ];
  expect(subject.events).toEqual(expected);
  expect(subject.open.mock.calls).toEqual(opened ? [[subject.filePath, expectedHashOpenFlags()]] : []);
  expect(subject.handles).toHaveLength(opened ? 1 : 0);
  expect(subject.close).toHaveBeenCalledTimes(opened ? 1 : 0);
  expect(subject.read).toHaveBeenCalledTimes(hashing === "off" ? 2 : 0);
  expect(subject.nativeHash).toHaveBeenCalledTimes(hashing === "mock-native" ? 1 : 0);
  expect(subject.loader).toHaveBeenCalledTimes(hashing === "mock-native" ? 1 : 0);
  if (opened) {
    const fd = subject.close.mock.calls[0]![0];
    expect(subject.descriptors).toEqual(Array(counts.descriptor).fill(fd));
    expect(subject.handles[0]!.fd).toBe(-1);
    if (hashing === "mock-native") expect(subject.nativeHash).toHaveBeenCalledWith(fd);
    for (const call of subject.read.mock.calls) expect(call).toEqual([fd]);
  }
  for (const observation of subject.observations) {
    expect(observation.bigint).toBe(true);
    expect(typeof observation.dev).toBe("bigint");
    expect(typeof observation.ino).toBe("bigint");
  }
}

// These are Windows identity representation models over real local I/O, not
// Windows kernel proof or an explanation of any particular coverage event.
describe.each(["off", "mock-native"] as const)("pathname hash Windows identity model (%s)", (mode) => {
  it("hashes only after all three stable identities are verified", async () => {
    const subject = await fixture({}, mode);
    await expect(sha256File(subject.filePath)).resolves.toEqual(abcHash);
    assertTrace(subject, { preview: 1, descriptor: 1, current: 1 }, mode);
  });

  describe.each(boundaries)("%s boundary", (boundary) => {
    it.each(unknowns)("recovers transient unknown $label with one retry", async ({ value }) => {
      const subject = await fixture({ [boundary]: [value, {}] }, mode);
      await expect(sha256File(subject.filePath)).resolves.toEqual(abcHash);
      assertTrace(subject, expectedCounts(boundary, 2, true), mode);
    });

    it.each(unknowns)("rejects persistent unknown $label after one retry", async ({ value }) => {
      const subject = await fixture({ [boundary]: [value] }, mode);
      await expect(sha256File(subject.filePath)).rejects.toMatchObject({ code: "path-mismatch" });
      assertTrace(subject, expectedCounts(boundary, 2));
    });

    it.each(["dev", "ino"] as const)("retains known %s across an unknown retry", async (knownField) => {
      const unknownField = knownField === "dev" ? "ino" : "dev";
      const subject = await fixture({ [boundary]: [
        { [unknownField]: 0n },
        { [knownField]: hashIdentity[knownField] + 1n },
      ] }, mode);
      await expect(sha256File(subject.filePath)).rejects.toMatchObject({ code: "path-mismatch" });
      assertTrace(subject, expectedCounts(boundary, 2));
    });

    it("does not merge alternating unknown components into a complete receipt", async () => {
      const subject = await fixture({ [boundary]: [{ dev: 0n }, { ino: 0n }] }, mode);
      await expect(sha256File(subject.filePath)).rejects.toMatchObject({ code: "path-mismatch" });
      assertTrace(subject, expectedCounts(boundary, 2));
    });

    it.each([false, true])("propagates inspection I/O errors without extra retry (retry=%s)", async (retry) => {
      const failure = Object.assign(new Error("inspection denied"), { code: "EACCES" });
      const subject = await fixture({ [boundary]: retry ? [{ ino: 0n }, failure] : [failure] }, mode);
      await expect(sha256File(subject.filePath)).rejects.toBe(failure);
      assertTrace(subject, expectedCounts(boundary, retry ? 2 : 1));
    });
  });

  describe.each(["descriptor", "current"] as const)("%s expected receipt", (boundary) => {
    it.each(["dev", "ino"] as const)("rejects known differing %s beside unknown immediately", async (knownField) => {
      const unknownField = knownField === "dev" ? "ino" : "dev";
      const subject = await fixture({ [boundary]: [
        { [unknownField]: 0n, [knownField]: hashIdentity[knownField] + 1n }, {},
      ] }, mode);
      await expect(sha256File(subject.filePath)).rejects.toMatchObject({ code: "path-mismatch" });
      assertTrace(subject, expectedCounts(boundary, 1));
    });

    it.each(["dev", "ino"] as const)("retains expected %s when the first observation makes it unknown", async (field) => {
      const subject = await fixture({ [boundary]: [{ [field]: 0n }, { [field]: hashIdentity[field] + 1n }] }, mode);
      await expect(sha256File(subject.filePath)).rejects.toMatchObject({ code: "path-mismatch" });
      assertTrace(subject, expectedCounts(boundary, 2));
    });

    it("rejects distinct high inode IDs with colliding numeric projections", async () => {
      expect(Number(hashIdentity.ino + 1n)).toBe(Number(hashIdentity.ino));
      const subject = await fixture({ [boundary]: [{ ino: hashIdentity.ino + 1n }] }, mode);
      await expect(sha256File(subject.filePath)).rejects.toMatchObject({ code: "path-mismatch" });
      assertTrace(subject, expectedCounts(boundary, 1));
    });
  });

  it.each([
    { boundary: "preview", kind: "symlink", code: "symlink" },
    { boundary: "preview", kind: "not-file", code: "not-file" },
    { boundary: "descriptor", kind: "not-file", code: "not-file" },
    { boundary: "current", kind: "symlink", code: "path-mismatch" },
    { boundary: "current", kind: "not-file", code: "path-mismatch" },
  ] as const)("repeats $boundary $kind check on unknown retry ($code)", async ({ boundary, kind, code }) => {
    const subject = await fixture({ [boundary]: [{ ino: 0n }, { kind }] }, mode);
    await expect(sha256File(subject.filePath)).rejects.toMatchObject({ code });
    assertTrace(subject, expectedCounts(boundary, 2));
  });

  it("permits one retry independently at each boundary without reopening", async () => {
    const subject = await fixture({
      preview: [{ dev: 0n }, {}], descriptor: [{ ino: 0n }, {}], current: [{ dev: 0n, ino: 0n }, {}],
    }, mode);
    await expect(sha256File(subject.filePath)).resolves.toEqual(abcHash);
    assertTrace(subject, { preview: 2, descriptor: 2, current: 2 }, mode);
  });
});
