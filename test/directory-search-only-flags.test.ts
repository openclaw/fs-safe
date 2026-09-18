import { afterEach, describe, expect, it } from "vitest";
import { nodeDirectorySearchOnlyFlags } from "../src/directory-mode-node.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const linuxArchitectures = [
  "arm", "arm64", "ia32", "loong64", "mips", "mipsel", "mips64el",
  "ppc", "ppc64", "riscv64", "s390", "s390x", "x64",
];

function simulate(os: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: os });
  Object.defineProperty(process, "arch", { value: arch });
}

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", architecture);
});

describe("directory search-only flags", () => {
  it.each(linuxArchitectures)("uses the verified Linux O_PATH value for %s", arch => {
    simulate("linux", arch);
    expect(nodeDirectorySearchOnlyFlags()).toEqual({ flags: 0x200000, proc: true });
  });

  it.each(["arm64", "x64"])("retains Darwin O_SEARCH for %s", arch => {
    simulate("darwin", arch);
    expect(nodeDirectorySearchOnlyFlags()).toEqual({ flags: 0x40000000, proc: false });
  });

  it.each(linuxArchitectures.filter(arch => arch !== "arm64" && arch !== "x64"))(
    "does not extend Darwin numeric flags to %s", arch => {
      simulate("darwin", arch);
      expect(nodeDirectorySearchOnlyFlags()).toBeUndefined();
    },
  );

  it.each(["sparc", "sparc64", "parisc", "alpha", "unknown"])("rejects unverified Linux ABI %s", arch => {
    simulate("linux", arch);
    expect(nodeDirectorySearchOnlyFlags()).toBeUndefined();
  });

  it.each(["win32", "freebsd", "aix"])("does not reuse Linux flags on %s", os => {
    simulate(os, "x64");
    expect(nodeDirectorySearchOnlyFlags()).toBeUndefined();
  });
});
