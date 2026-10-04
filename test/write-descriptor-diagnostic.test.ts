import { expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { normalizePinnedWriteError } from "../src/root-errors.js";
import { createSuppressedError } from "../src/suppressed-error.js";

it.each([
  ["EMFILE", "helper-failed", "operational", "filesystem write failed: too many open files"],
  ["ENFILE", "helper-failed", "operational", "filesystem write failed: too many open files"],
  ["ENOSPC", "invalid-path", "policy", "no space left on device"],
])("reports resource exhaustion through publication and disposal (%s)", (code, classified, category, message) => {
  const errno = Object.assign(new Error("native path must not reach display text"), { code });
  const publication = new FsSafeError("helper-failed", "staged file publish failed", { cause: errno });
  const details = { phase: "cleanup", publication: { status: "indeterminate" }, cleanup: { status: "preserved", resources: "closed" } };
  const cleanup = new FsSafeError("not-removable", "staged cleanup preserved an unverified entry", { details });
  const suppressed = createSuppressedError(cleanup, publication, "disposal failed");
  expect(normalizePinnedWriteError(suppressed)).toMatchObject({
    code: classified, category, cause: suppressed, details,
    message: `${message} (${code}); publication outcome is indeterminate; staged file preserved`,
  });
  expect(normalizePinnedWriteError(errno)).toMatchObject({ code: classified, category, cause: errno });
  const aggregate = new AggregateError([publication, cleanup], "write and cleanup failed");
  expect(normalizePinnedWriteError(aggregate)).toMatchObject({
    code: classified, category, cause: aggregate, details,
    message: `${message} (${code}); publication outcome is indeterminate; staged file preserved`,
  });
});

it.each(["EMFILE", "ENOSPC"])("keeps boundary failures primary and terminates cyclic cause chains (%s)", code => {
  const errno = Object.assign(new Error("exhausted"), { code });
  const boundary = new FsSafeError("path-mismatch", "identity unavailable", { cause: errno });
  expect(normalizePinnedWriteError(boundary)).toBe(boundary);
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(normalizePinnedWriteError(cycle)).toMatchObject({ code: "invalid-path", cause: cycle });
});

it("retains classified disk failures and descriptor-exhaustion precedence", () => {
  const disk = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const classified = new FsSafeError("helper-failed", "owned failure", { cause: disk });
  expect(normalizePinnedWriteError(classified)).toBe(classified);
  const descriptor = Object.assign(new Error("descriptor limit"), { code: "EMFILE" });
  for (const failures of [[disk, descriptor], [descriptor, disk]]) {
    expect(normalizePinnedWriteError(new AggregateError(failures))).toMatchObject({
      code: "helper-failed", category: "operational", message: "filesystem write failed: too many open files (EMFILE)",
    });
  }
});

it("retains preserved-stage receipts and all causes when preparation or disposal also fails", () => {
  const errno = Object.assign(new Error("exhausted"), { code: "EMFILE" });
  const close = new Error("close failed");
  const aggregate = new AggregateError([errno, close], "preparation and cleanup failed");
  expect(normalizePinnedWriteError(new FsSafeError("helper-failed", "staged file prepare failed", { cause: aggregate })))
    .toMatchObject({ code: "helper-failed", message: expect.stringContaining("EMFILE") });
  const details = { phase: "cleanup", publication: { status: "indeterminate" }, cleanup: { status: "preserved", resources: "close-failed" } };
  const cleanup = new FsSafeError("helper-failed", "staged file cleanup failed", { cause: close, details });
  const suppressed = createSuppressedError(cleanup, errno, "disposal failed");
  expect(normalizePinnedWriteError(suppressed)).toMatchObject({
    code: "helper-failed", cause: suppressed, details, message: expect.stringContaining("staged file preserved"),
  });
  const boundary = new FsSafeError("path-mismatch", "changed identity");
  expect(normalizePinnedWriteError(new FsSafeError("helper-failed", "combined", {
    cause: new AggregateError([boundary, errno]),
  })).message).toBe("combined");
});
