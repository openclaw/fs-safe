import { expect, it, vi } from "vitest";
import type { NativeDirectoryObservationBackend } from "../src/native-directory-observation.js";
import { inspectNativeDirectoryObservation } from "../src/native-directory-observation.js";
import { __loadBundledNativeForTest } from "../src/native.js";

const requireNativeObservation =
  process.env.FS_SAFE_REQUIRE_NATIVE_DIRECTORY_OBSERVATION === "1";

function backend(
  observeDirectory: NativeDirectoryObservationBackend["observeDirectory"],
): NativeDirectoryObservationBackend {
  return { observeDirectory } as NativeDirectoryObservationBackend;
}

it("retains exact bigint directory identities from the fused observation", () => {
  const exact = 9_007_199_254_740_993n;
  const observeDirectory = vi.fn(() => ({ dev: exact, ino: exact + 2n, realPath: "/root/dir" }));
  const observed = inspectNativeDirectoryObservation(
    backend(observeDirectory),
    "/root/dir",
    { dev: exact, ino: exact + 2n },
    "linux",
  );
  expect(observed).toEqual({ dev: exact, ino: exact + 2n, realPath: "/root/dir" });
  expect(observeDirectory).toHaveBeenCalledTimes(1);
});

it("preserves the two-observation Windows unknown-identity rule", () => {
  const observeDirectory = vi.fn()
    .mockReturnValueOnce({ dev: 41n, ino: 0n, realPath: "C:\\root\\dir" })
    .mockReturnValueOnce({ dev: 41n, ino: 43n, realPath: "C:\\root\\dir" });
  const observed = inspectNativeDirectoryObservation(
    backend(observeDirectory),
    "C:\\root\\dir",
    { dev: 41n, ino: 43n },
    "win32",
  );
  expect(observed.ino).toBe(43n);
  expect(observeDirectory).toHaveBeenCalledTimes(2);
});

it("rejects persistent unknown and changing Windows identities", () => {
  for (const observations of [
    [
      { dev: 41n, ino: 0n, realPath: "C:\\root\\dir" },
      { dev: 41n, ino: 0n, realPath: "C:\\root\\dir" },
    ],
    [
      { dev: 41n, ino: 0n, realPath: "C:\\root\\dir" },
      { dev: 47n, ino: 43n, realPath: "C:\\root\\dir" },
    ],
  ]) {
    const observeDirectory = vi.fn()
      .mockReturnValueOnce(observations[0]!)
      .mockReturnValueOnce(observations[1]!);
    expect(() => inspectNativeDirectoryObservation(
      backend(observeDirectory),
      "C:\\root\\dir",
      undefined,
      "win32",
    )).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  }
});

it("rejects malformed helper observations", () => {
  const invalid = backend(() => ({ dev: -1n, ino: 2n, realPath: "relative" }));
  expect(() => inspectNativeDirectoryObservation(invalid, "/root/dir", undefined, "linux"))
    .toThrow(expect.objectContaining({ code: "path-mismatch" }));
});

it("exports the directory observation ABI when native proof is required", (context) => {
  if (!requireNativeObservation) return context.skip("native proof not requested");
  const native = __loadBundledNativeForTest();
  expect(native.observeDirectory).toBeTypeOf("function");
});
