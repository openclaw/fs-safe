import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { readJsonDurableQueueEntry } from "../src/json-durable-queue.js";
import {
  observeQueueRead, queueIdentity, queuePayload, type QueueBoundary, type QueueSamples,
} from "./helpers/queue-read-identity.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const boundaries = ["preview", "descriptor", "current"] as const;
const unknowns = [
  { label: "dev", value: { dev: 0n } },
  { label: "ino", value: { ino: 0n } },
  { label: "both", value: { dev: 0n, ino: 0n } },
];
const changed = "queue entry changed during read";

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

async function fixture(samples: QueueSamples = {}) {
  const directory = await tempRoot("fs-safe-queue-identity-");
  Object.defineProperty(process, "platform", { value: "win32" });
  return await observeQueueRead(directory, samples);
}

function countsFor(boundary: QueueBoundary, attempts: number, success = false) {
  return Object.fromEntries(boundaries.map((stage, index) =>
    [stage, stage === boundary ? attempts : success || index < boundaries.indexOf(boundary) ? 1 : 0],
  )) as Record<QueueBoundary, number>;
}

function assertTrace(
  subject: Awaited<ReturnType<typeof fixture>>,
  counts: Record<QueueBoundary, number>,
  success = false,
) {
  expect(subject.counts).toEqual(counts);
  const opened = counts.descriptor > 0;
  expect(subject.events).toEqual([
    ...Array(counts.preview).fill("preview"),
    ...(opened ? ["open"] : []),
    ...Array(counts.descriptor).fill("descriptor"),
    ...Array(counts.current).fill("current"),
    ...(success ? ["read", "read"] : []),
    ...(opened ? ["close"] : []),
  ]);
  expect(subject.open.mock.calls).toEqual(opened ? [[subject.filePath, fs.constants.O_RDONLY]] : []);
  expect(subject.handles).toHaveLength(opened ? 1 : 0);
  expect(subject.close).toHaveBeenCalledTimes(opened ? 1 : 0);
  expect(subject.read).toHaveBeenCalledTimes(success ? 2 : 0);
  if (opened) expect(subject.handles[0]!.fd).toBe(-1);
  for (const observation of subject.observations) expect(observation.bigint).toBe(true);
}

// Deterministic representation models prove the owner contract, not the cause
// of a particular Windows runner failure whose identities were not recorded.
describe("durable queue Windows identity receipts", () => {
  it("reads and parses only after stable preview, descriptor and current receipts", async () => {
    const subject = await fixture();
    const parse = vi.spyOn(JSON, "parse");
    await expect(readJsonDurableQueueEntry(subject.filePath)).resolves.toEqual({ entry: "original" });
    expect(parse).toHaveBeenCalledWith(queuePayload);
    assertTrace(subject, { preview: 1, descriptor: 1, current: 1 }, true);
  });

  describe.each(boundaries)("%s boundary", (boundary) => {
    it.each(unknowns)("recovers a transient unknown $label once", async ({ value: unknown }) => {
      const subject = await fixture({ [boundary]: [unknown, {}] });
      await expect(readJsonDurableQueueEntry(subject.filePath)).resolves.toEqual({ entry: "original" });
      assertTrace(subject, countsFor(boundary, 2, true), true);
    });

    it.each(unknowns)("rejects persistent unknown $label before reading or parsing", async ({ value: unknown }) => {
      const subject = await fixture({ [boundary]: [unknown] });
      const parse = vi.spyOn(JSON, "parse");
      await expect(readJsonDurableQueueEntry(subject.filePath)).rejects.toMatchObject({
        message: changed, cause: { code: "path-mismatch" },
      });
      expect(parse).not.toHaveBeenCalledWith(queuePayload);
      assertTrace(subject, countsFor(boundary, 2));
    });

    it.each(["dev", "ino"] as const)("retains known %s across an unknown retry", async (field) => {
      const other = field === "dev" ? "ino" : "dev";
      const subject = await fixture({ [boundary]: [{ [other]: 0n }, { [field]: queueIdentity[field] + 1n }] });
      await expect(readJsonDurableQueueEntry(subject.filePath)).rejects.toThrow(changed);
      assertTrace(subject, countsFor(boundary, 2));
    });

    it("does not combine incomplete receipts", async () => {
      const subject = await fixture({ [boundary]: [{ dev: 0n }, { ino: 0n }] });
      await expect(readJsonDurableQueueEntry(subject.filePath)).rejects.toThrow(changed);
      assertTrace(subject, countsFor(boundary, 2));
    });

    it.each([false, true])("preserves callback failures without identity translation (retry=%s)", async (retry) => {
      // Even a callback's path-mismatch error is not the helper's rejection.
      const failure = new FsSafeError("path-mismatch", "inspection callback failed");
      const subject = await fixture({ [boundary]: retry ? [{ ino: 0n }, failure] : [failure] });
      await expect(readJsonDurableQueueEntry(subject.filePath)).rejects.toBe(failure);
      assertTrace(subject, countsFor(boundary, retry ? 2 : 1));
    });

    it.each([
      { sample: { kind: "not-file" }, message: "queue entry is not a regular file" },
      { sample: { nlink: 2n }, message: "queue entry hardlinks are not allowed" },
      { sample: { size: 100n }, message: "queue entry exceeds 64 bytes" },
    ] as const)("revalidates $message on the bounded retry", async ({ sample, message }) => {
      const subject = await fixture({ [boundary]: [{ ino: 0n }, sample] });
      await expect(readJsonDurableQueueEntry(subject.filePath, { maxBytes: 64 })).rejects.toThrow(message);
      assertTrace(subject, countsFor(boundary, 2));
    });
  });

  describe.each(["descriptor", "current"] as const)("%s expected identity", (boundary) => {
    it("rejects high inode identities with identical numeric projections", async () => {
      expect(Number(queueIdentity.ino + 1n)).toBe(Number(queueIdentity.ino));
      const subject = await fixture({ [boundary]: [{ ino: queueIdentity.ino + 1n }] });
      await expect(readJsonDurableQueueEntry(subject.filePath)).rejects.toThrow(changed);
      assertTrace(subject, countsFor(boundary, 1));
    });

    it.each(["dev", "ino"] as const)("rejects a known %s mismatch beside an unknown immediately", async (field) => {
      const other = field === "dev" ? "ino" : "dev";
      const subject = await fixture({ [boundary]: [{ [other]: 0n, [field]: queueIdentity[field] + 1n }, {}] });
      await expect(readJsonDurableQueueEntry(subject.filePath)).rejects.toThrow(changed);
      assertTrace(subject, countsFor(boundary, 1));
    });
  });

  it.each(["preview", "current"] as const)("rejects a symlink on %s reinspection", async (boundary) => {
    const subject = await fixture({ [boundary]: [{ ino: 0n }, { kind: "symlink" }] });
    await expect(readJsonDurableQueueEntry(subject.filePath)).rejects.toThrow("queue entry is not a regular file");
    assertTrace(subject, countsFor(boundary, 2));
  });

  it("reinspects each boundary at most once without reopening", async () => {
    const subject = await fixture({ preview: [{ dev: 0n }, {}], descriptor: [{ ino: 0n }, {}], current: [{ dev: 0n, ino: 0n }, {}] });
    await expect(readJsonDurableQueueEntry(subject.filePath)).resolves.toEqual({ entry: "original" });
    assertTrace(subject, { preview: 2, descriptor: 2, current: 2 }, true);
  });
});
