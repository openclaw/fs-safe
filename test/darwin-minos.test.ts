import { describe, expect, it } from "vitest";
import { assertDarwinMinos } from "../scripts/check-darwin-minos.mjs";

const build = (minos: string) => `Load command 9\n cmd LC_BUILD_VERSION\n platform MACOS\n minos ${minos}\n sdk 27.0\n ntools 1\n tool LD\n version 1300.0\n`;
const legacy = (version: string) => `Load command 8\n cmd LC_VERSION_MIN_MACOSX\n version ${version}\n sdk 27.0\n`;

describe("published Darwin deployment floors", () => {
  it("accepts both modern and legacy deployment commands", () => {
    expect(assertDarwinMinos(build("11.0"), "arm64")).toBe("11.0");
    expect(assertDarwinMinos(legacy("10.12.0"), "x64")).toBe("10.12");
  });
  it("rejects a raised floor for either architecture", () => {
    expect(() => assertDarwinMinos(build("27.0"), "arm64")).toThrow("minimum changed");
    expect(() => assertDarwinMinos(legacy("11.0"), "x64")).toThrow("minimum changed");
  });
  it("rejects missing, ambiguous, or unsupported architecture metadata", () => {
    expect(() => assertDarwinMinos("sdk 27.0", "arm64")).toThrow("missing or ambiguous");
    expect(() => assertDarwinMinos(build("11.0") + build("11.0"), "arm64")).toThrow("missing or ambiguous");
    expect(() => assertDarwinMinos(build("11.0"), "other")).toThrow("unsupported");
  });
});
