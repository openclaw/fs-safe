import { describe, expect, it, vi } from "vitest";
import { nativeStagedFileMode } from "../src/native-staged-file-metadata.js";
import type { NativeBinding } from "../src/native.js";

function binding(value: unknown): NativeBinding {
  return { stagedFileMetadata: vi.fn(() => value) } as unknown as NativeBinding;
}

describe("native staged-file metadata", () => {
  it("uses exact returned mode/link facts and retains the older-binding fallback", () => {
    expect(nativeStagedFileMode(binding({ mode: 0o100600n, nlink: 1n }), 1, "stage", 2, 0o600)).toBe(0o600);
    expect(nativeStagedFileMode({} as NativeBinding, 1, "stage", 2)).toBeUndefined();
  });

  it.each([null, undefined, { mode: 0o100600, nlink: 1n }, { mode: 0o100600n, nlink: 2n },
    { mode: 0o040600n, nlink: 1n }, { mode: -1n, nlink: 1n }, { mode: 1n << 32n, nlink: 1n }])(
    "fails closed for unmatched or malformed metadata %#", value => {
      expect(() => nativeStagedFileMode(binding(value), 1, "stage", 2)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    },
  );

  it("preserves the exact permission check", () => {
    expect(() => nativeStagedFileMode(binding({ mode: 0o100644n, nlink: 1n }), 1, "stage", 2, 0o600))
      .toThrow(expect.objectContaining({ code: "insecure-permissions" }));
  });
});
