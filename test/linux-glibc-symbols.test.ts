import { describe, expect, it } from "vitest";
import { checkGlibcSymbols } from "../scripts/check-linux-glibc.mjs";

describe("Linux GNU artifact ABI gate", () => {
  it("compares symbol versions numerically and accepts the floor", () => {
    expect(checkGlibcSymbols(`
0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.3.4) __xpg_strerror_r
0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.28) statx
0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.9) pipe2
`)).toBe("2.28");
    expect(checkGlibcSymbols("(GLIBC_2.17) clock_gettime")).toBe("2.17");
  });

  it.each(["2.28.1", "2.34", "2.100", "3.0"])("rejects a newer requirement %s", (version) => {
    expect(() => checkGlibcSymbols(`(GLIBC_2.2.5) close\n(GLIBC_${version}) pthread_create`))
      .toThrow(`requires GLIBC_${version}, exceeds GLIBC_2.28`);
  });

  it.each(["GLIBC_PRIVATE", "GLIBC_ABI_DT_RELR"])("rejects unversioned requirements %s", (symbol) => {
    expect(() => checkGlibcSymbols(`(GLIBC_2.17) close\n(${symbol}) hidden`))
      .toThrow(`unsupported glibc requirement: ${symbol}`);
  });

  it("rejects empty or non-glibc artifacts", () => {
    expect(() => checkGlibcSymbols("no versioned symbols")).toThrow("no GLIBC symbol versions found");
  });
});
