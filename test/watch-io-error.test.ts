import { expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { createSuppressedError } from "../src/suppressed-error.js";
import { encodeWatchError, decodeWatchError } from "../src/watch-io-error.js";

it("retains both scan and retirement failures across the worker boundary", () => {
  const scan = new FsSafeError("path-mismatch", "directory replaced", { details: { operation: "scan" }, cause: new Error("identity") });
  const close = Object.assign(new Error("close failed"), { code: "EIO" });
  const wire = structuredClone(encodeWatchError(createSuppressedError(close, scan, "scan and close failed")));
  const decoded = decodeWatchError(wire) as Error & { error: unknown; suppressed: FsSafeError };
  expect(decoded).toMatchObject({ name: "SuppressedError", message: "scan and close failed",
    error: { message: "close failed", code: "EIO" }, suppressed: { code: "path-mismatch", details: { operation: "scan" }, cause: { message: "identity" } } });
  expect(decoded.suppressed).toBeInstanceOf(FsSafeError);
});
