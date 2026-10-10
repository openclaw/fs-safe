import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const refusalCodes = ["EACCES", "EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"];
const transitions = ["claim", "batch-claim", "quarantine", "retirement", "batch-retirement"] as const;
type Transition = typeof transitions[number];

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

async function fixture(transition: Transition) {
  const directory = await tempRoot("fs-safe-queue-link-refusal-");
  const queueDir = path.join(directory, "queue");
  const failedDir = path.join(directory, "failed");
  await ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  const failedPath = path.join(failedDir, "job.json");
  const retirementDir = path.join(queueDir, ".fs-safe-retirements", "job.json");
  const entryPath = path.join(retirementDir, "entry");
  const retirement = transition.endsWith("retirement");
  const claim = transition.endsWith("claim");
  const sourcePath = retirement ? entryPath : claim ? paths.jsonPath : paths.processingPath!;
  const targetPath = retirement ? paths.jsonPath : claim ? paths.processingPath! : failedPath;
  if (retirement) await fs.mkdir(retirementDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(sourcePath, JSON.stringify({ generation: retirement ? 2 : 1 }));
  if (retirement) await fs.writeFile(paths.processingPath!, JSON.stringify({ generation: 1 }));
  if (transition === "quarantine") {
    await fs.writeFile(paths.jsonPath, JSON.stringify({ generation: 2 }));
  }
  const run = () => transition === "quarantine"
    ? moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" })
    : transition.startsWith("batch-")
      ? loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue" })
      : loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
  const evidencePaths = claim ? [sourcePath] : [sourcePath, retirement ? paths.processingPath! : paths.jsonPath];
  const evidence = await Promise.all(evidencePaths.map(async filePath => ({
    filePath, bytes: await fs.readFile(filePath), identity: await fs.lstat(filePath, { bigint: true }),
  })));
  return { run, paths, sourcePath, targetPath, retirementDir, evidence };
}

async function expectEvidenceUnchanged(subject: Awaited<ReturnType<typeof fixture>>) {
  for (const { filePath, bytes, identity } of subject.evidence) {
    expect(await fs.readFile(filePath)).toEqual(bytes);
    expect(await fs.lstat(filePath, { bigint: true })).toMatchObject({
      dev: identity.dev, ino: identity.ino, nlink: 1n,
    });
  }
  await expect(fs.lstat(subject.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.each(["off", "auto"] as const)("durable queue hardlink refusal (native %s)", mode => {
  describe.each(transitions)("%s", transition => {
    it.each(refusalCodes)("reports %s as unavailable without changing ownership evidence", async code => {
      configureFsSafeNative({ mode });
      const subject = await fixture(transition);
      const failure = Object.assign(new Error("hardlink refused"), { code });
      const link = vi.spyOn(fs, "link").mockRejectedValue(failure);

      await expect(subject.run()).rejects.toMatchObject({
        name: "FsSafeError", code: "helper-unavailable", cause: failure,
      });
      expect(link).toHaveBeenCalledExactlyOnceWith(subject.sourcePath, subject.targetPath);
      await expectEvidenceUnchanged(subject);
    });

    it.each(["EIO", "EMFILE", "ENOSPC"])("preserves unrelated %s errors", async code => {
      configureFsSafeNative({ mode });
      const subject = await fixture(transition);
      const failure = Object.assign(new Error("link failed"), { code });
      vi.spyOn(fs, "link").mockRejectedValue(failure);
      await expect(subject.run()).rejects.toBe(failure);
      await expectEvidenceUnchanged(subject);
    });

    it("can retry after repeated refusal without losing or acknowledging a generation", async () => {
      configureFsSafeNative({ mode });
      const subject = await fixture(transition);
      const failure = Object.assign(new Error("link refused"), { code: "EACCES" });
      const link = vi.spyOn(fs, "link").mockRejectedValue(failure);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(subject.run()).rejects.toMatchObject({ code: "helper-unavailable", cause: failure });
        await expectEvidenceUnchanged(subject);
      }
      link.mockRestore();
      await subject.run();
      const claimed = transition === "quarantine" ? subject.targetPath : subject.paths.processingPath!;
      expect(JSON.parse(await fs.readFile(claimed, "utf8"))).toEqual({ generation: 1 });
      expect((await fs.lstat(claimed, { bigint: true })).nlink).toBe(1n);
      if (transition.endsWith("retirement") || transition === "quarantine") {
        expect(JSON.parse(await fs.readFile(subject.paths.jsonPath, "utf8"))).toEqual({ generation: 2 });
      }
      if (transition.endsWith("retirement")) {
        await expect(fs.lstat(subject.retirementDir)).rejects.toMatchObject({ code: "ENOENT" });
        await ackJsonDurableQueueEntry(subject.paths);
        await expect(loadJsonDurableQueueEntry({ paths: subject.paths, tempPrefix: "queue" }))
          .resolves.toEqual({ generation: 2 });
      }
    });
  });
});

it("preserves a competing claim and pending generation on EEXIST", async () => {
  configureFsSafeNative({ mode: "off" });
  const subject = await fixture("claim");
  vi.spyOn(fs, "link").mockImplementation(async () => {
    await fs.writeFile(subject.targetPath, JSON.stringify({ generation: "competing" }));
    throw Object.assign(new Error("claim exists"), { code: "EEXIST" });
  });
  await expect(subject.run()).resolves.toEqual({ generation: "competing" });
  expect(JSON.parse(await fs.readFile(subject.paths.jsonPath, "utf8"))).toEqual({ generation: 1 });
});

it.each(["claim", "batch-claim"] as const)("preserves missing-source handling for %s", async transition => {
  configureFsSafeNative({ mode: "off" });
  const subject = await fixture(transition);
  vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("source disappeared"), { code: "ENOENT" }));
  await expect(subject.run()).resolves.toEqual(transition === "claim" ? null : []);
  await expectEvidenceUnchanged(subject);
});
