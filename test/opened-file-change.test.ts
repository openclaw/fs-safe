import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { fileObservation, recordFileObservationFailure } from "../src/file-observation.js";
import { recordPreOpenFileChange } from "../src/opened-file-failure.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", platform));
const stat = (ino: bigint) => ({ dev: 1n, ino, nlink: 1n, isFile: () => true }) as BigIntStats;

it.each([0n, 1n])("records a distinct pre-open generation with current nlink %s, not an unlink receipt", async (nlink) => {
  const observation = fileObservation(), error = new Error("identity mismatch");
  const before = stat(1n), opened = stat(2n), current = { ...opened, nlink };
  const handle = { stat: vi.fn(async () => current) } as unknown as FileHandle;
  await observation.run(async () => {
    recordFileObservationFailure(error, "identity");
    await recordPreOpenFileChange(error, handle, "state.lock", before, opened);
  });
  expect(observation.has(error, "changed:state.lock")).toBe(true);
  expect(observation.has(error, "unlinked:state.lock")).toBe(false);
});

it.each([
  "same", "before-missing", "opened-missing", "before-numeric", "opened-numeric", "current-numeric",
  "before-unknown", "opened-unknown", "current-unknown", "before-multilink", "opened-multilink", "current-multilink",
  "before-nonfile", "opened-nonfile", "current-nonfile", "current-drift", "closed", "EACCES", "unmarked",
])("does not authorize discarding %s evidence", async (kind) => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const observation = fileObservation(), error = new Error("identity mismatch");
  const before = stat(1n), opened = stat(2n), current = stat(2n);
  for (const [label, value] of [["before", before], ["opened", opened], ["current", current]] as const) {
    if (kind === `${label}-numeric`) Object.assign(value, { ino: Number(value.ino) });
    if (kind === `${label}-unknown`) value.ino = 0n;
    if (kind === `${label}-multilink`) value.nlink = 2n;
    if (kind === `${label}-nonfile`) value.isFile = () => false;
  }
  if (kind === "same") before.ino = opened.ino;
  if (kind === "current-drift") current.ino = 3n;
  const handle = { stat: vi.fn(async () => {
    if (kind === "closed" || kind === "EACCES") throw Object.assign(new Error("stat failed"), { code: kind === "closed" ? "EBADF" : kind });
    return current;
  }) } as unknown as FileHandle;
  await observation.run(async () => {
    if (kind !== "unmarked") recordFileObservationFailure(error, "identity");
    await recordPreOpenFileChange(error, handle, "state.lock",
      kind === "before-missing" ? undefined : before, kind === "opened-missing" ? undefined : opened);
  });
  expect(observation.has(error, "changed:state.lock")).toBe(false);
  expect(observation.has(error, "unlinked:state.lock")).toBe(false);
});

it("does not reuse a changed-file receipt in a later observation", async () => {
  const first = fileObservation(), next = fileObservation(), error = new Error("identity mismatch");
  const handle = { stat: vi.fn(async () => stat(2n)) } as unknown as FileHandle;
  await first.run(async () => {
    recordFileObservationFailure(error, "identity");
    await recordPreOpenFileChange(error, handle, "state.lock", stat(1n), stat(2n));
  });
  await next.run(() => recordPreOpenFileChange(error, handle, "state.lock", stat(1n), stat(2n)));
  expect(first.has(error, "changed:state.lock")).toBe(true);
  expect(next.has(error, "changed:state.lock")).toBe(false);
});
