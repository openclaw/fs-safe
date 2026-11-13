import fsSync, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { fileObservation, recordFileObservationFailure } from "../src/file-observation.js";
import { recordPreOpenFileChange } from "../src/opened-file-failure.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
const stat = (ino: bigint) => ({ dev: 1n, ino, nlink: 1n, isFile: () => true }) as BigIntStats;

it.each([[1n, 0n], [1n, 1n], [2n, 0n], [2n, 1n]])("records a distinct pre-open generation with initial/current links %s/%s, not an unlink receipt", async (initial, nlink) => {
  const observation = fileObservation(), error = new Error("identity mismatch");
  const before = stat(1n), opened = { ...stat(2n), nlink: initial }, current = { ...opened, nlink };
  const handle = { fd: 123, stat: async () => current } as FileHandle;
  vi.spyOn(fsSync, "fstatSync").mockReturnValue(current);
  await observation.run(async () => {
    recordFileObservationFailure(error, "identity");
    await recordPreOpenFileChange(error, handle, "state.lock", before, opened);
  });
  expect(observation.has(error, "changed:state.lock")).toBe(true);
  expect(observation.has(error, "unlinked:state.lock")).toBe(false);
});

it.each([
  "same", "before-missing", "opened-missing", "before-numeric", "opened-numeric", "current-numeric",
  "before-unknown", "opened-unknown", "current-unknown", "before-multilink", "opened-excess-links", "current-multilink",
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
  if (kind === "opened-excess-links") opened.nlink = 3n;
  if (kind === "same") before.ino = opened.ino;
  if (kind === "current-drift") current.ino = 3n;
  const handle = { fd: 123 } as FileHandle;
  vi.spyOn(fsSync, "fstatSync").mockImplementation(() => {
    if (kind === "closed" || kind === "EACCES") throw Object.assign(new Error("stat failed"), { code: kind === "closed" ? "EBADF" : kind });
    return current;
  });
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
  const handle = { fd: 123, stat: async () => stat(2n) } as FileHandle;
  vi.spyOn(fsSync, "fstatSync").mockReturnValue(stat(2n));
  await first.run(async () => {
    recordFileObservationFailure(error, "identity");
    await recordPreOpenFileChange(error, handle, "state.lock", stat(1n), stat(2n));
  });
  await next.run(() => recordPreOpenFileChange(error, handle, "state.lock", stat(1n), stat(2n)));
  expect(first.has(error, "changed:state.lock")).toBe(true);
  expect(next.has(error, "changed:state.lock")).toBe(false);
});

it.each([false, true])("requires scoped publication proof for a still-linked generation (%s)", async publication => {
  const verify = vi.fn(async () => publication), first = fileObservation({ publicationPending: verify });
  const next = fileObservation(), error = new Error("identity mismatch");
  const opened = { ...stat(2n), nlink: 2n }, handle = { fd: 123, stat: async () => opened } as FileHandle;
  vi.spyOn(fsSync, "fstatSync").mockReturnValue(opened);
  await first.run(async () => {
    recordFileObservationFailure(error, "identity");
    await recordPreOpenFileChange(error, handle, "state.lock", stat(1n), opened);
  });
  expect(verify).toHaveBeenCalledWith("state.lock", opened);
  expect(first.has(error, "linked-change:state.lock")).toBe(publication);
  expect(first.has(error, "changed:state.lock")).toBe(false);
  expect(first.has(error, "unlinked:state.lock")).toBe(false);
  await next.run(() => recordPreOpenFileChange(error, handle, "state.lock", stat(1n), opened));
  expect(next.has(error, "linked-change:state.lock")).toBe(false);
  expect(verify).toHaveBeenCalledTimes(1);
});
