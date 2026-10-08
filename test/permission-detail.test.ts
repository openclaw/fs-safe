import { describe, expect, it } from "vitest";
import { formatErrorDetail } from "../src/error-detail.js";
import { formatPermissionErrorDetail } from "../src/permission-exec.js";

describe("bounded permission diagnostic formatting", () => {
  it.each(["x", "\u0000", "\u001b", "\u0085", "\u2028", "\u2029", "🦞"])("preserves escaping and truncation for %j", character => {
    for (const length of [0, 1, 66, 67, 398, 399, 400, 401, 4096]) {
      const value = character.repeat(length);
      const escaped = formatErrorDetail(value);
      expect(formatPermissionErrorDetail(value)).toBe(escaped.length > 400 ? `${escaped.slice(0, 399)}…` : escaped);
    }
  });

  it("preserves a control character or surrogate pair across the truncation boundary", () => {
    for (let offset = 393; offset <= 402; offset++) {
      const value = `${"x".repeat(offset)}\u0000🦞${"tail".repeat(1024)}`;
      const escaped = formatErrorDetail(value);
      expect(formatPermissionErrorDetail(value)).toBe(`${escaped.slice(0, 399)}…`);
    }
  });
});
