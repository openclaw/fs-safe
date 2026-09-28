import { expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { normalizePinnedWriteError } from "../src/root-errors.js";
import { createSuppressedError } from "../src/suppressed-error.js";

it.each(["EMFILE", "ENFILE"])("reports descriptor exhaustion through publication and disposal (%s)", code => {
  const errno = Object.assign(new Error("native path must not reach display text"), { code });
  const publication = new FsSafeError("helper-failed", "staged file publish failed", { cause: errno });
  const details = { phase: "cleanup", publication: { status: "indeterminate" }, cleanup: { status: "preserved", resources: "closed" } };
  const cleanup = new FsSafeError("not-removable", "staged cleanup preserved an unverified entry", { details });
  const suppressed = createSuppressedError(cleanup, publication, "disposal failed");
  expect(normalizePinnedWriteError(suppressed)).toMatchObject({
    code: "helper-failed", category: "operational", cause: suppressed, details,
    message: `filesystem write failed: too many open files (${code}); publication outcome is indeterminate; staged file preserved`,
  });
  expect(normalizePinnedWriteError(errno)).toMatchObject({ code: "helper-failed", cause: errno });
});

it("keeps boundary failures primary and terminates cyclic cause chains", () => {
  const errno = Object.assign(new Error("exhausted"), { code: "EMFILE" });
  const boundary = new FsSafeError("path-mismatch", "identity unavailable", { cause: errno });
  expect(normalizePinnedWriteError(boundary)).toBe(boundary);
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(normalizePinnedWriteError(cycle)).toMatchObject({ code: "invalid-path", cause: cycle });
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
