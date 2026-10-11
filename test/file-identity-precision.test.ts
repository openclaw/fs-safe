import { describe, expect, it } from "vitest";
import { sameFileIdentity } from "../src/file-identity.js";

describe("exact file identity comparisons", () => {
  const first = 2n ** 54n;
  const second = first + 1n;

  it.each(["win32", "linux", "darwin"] as const)("refuses rounded identities on %s", (platform) => {
    expect(first).not.toBe(second);
    expect(Number(first)).toBe(Number(second));
    for (const field of ["dev", "ino"] as const) {
      const left = { dev: 7n, ino: 11n, [field]: first };
      const right = { dev: 7n, ino: 11n, [field]: second };
      expect(sameFileIdentity(left, right, platform)).toBe(false);
      expect(sameFileIdentity({ ...left, [field]: Number(first) }, { ...right, [field]: Number(second) }, platform)).toBe(false);
      expect(sameFileIdentity({ ...left, [field]: Number(first) }, left, platform)).toBe(false);
      expect(sameFileIdentity(left, { ...left, [field]: Number(first) }, platform)).toBe(false);
      expect(sameFileIdentity(left, left, platform)).toBe(true);
    }
  });

  it.each([NaN, Infinity, -Infinity, 1.5])("refuses invalid numeric components (%s) without throwing", (ino) => {
    expect(sameFileIdentity({ dev: 7, ino }, { dev: 7n, ino: 11n })).toBe(false);
  });

  it("keeps safe mixed identities and the Windows unknown-component fallback", () => {
    expect(sameFileIdentity({ dev: 7, ino: 11 }, { dev: 7n, ino: 11n }, "win32")).toBe(true);
    expect(sameFileIdentity({ dev: 0, ino: 0 }, { dev: 7n, ino: first }, "win32")).toBe(true);
    expect(sameFileIdentity({ dev: 0, ino: Number(first) }, { dev: 7n, ino: 0n }, "win32")).toBe(false);
    expect(sameFileIdentity({ dev: 0, ino: 0 }, { dev: 7n, ino: first }, "linux")).toBe(false);
  });
});
