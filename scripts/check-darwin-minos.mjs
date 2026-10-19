import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Match the deployment commands in the published 0.26.8 native packages.
export const darwinDeploymentTargets = { arm64: "11.0", x64: "10.12" };

export function assertDarwinMinos(output, architecture) {
  const expected = darwinDeploymentTargets[architecture];
  if (!expected) throw new Error(`unsupported Darwin architecture: ${architecture}`);
  // vtool prints tool versions too; only inspect the deployment command.
  const commands = output.split(/(?=Load command \d+)/);
  const floors = commands
    .filter((command) => /cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b/.test(command))
    .flatMap((command) => [...command.matchAll(command.includes("LC_BUILD_VERSION")
      ? /^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$/gm
      : /^\s*version\s+(\d+(?:\.\d+){1,2})\s*$/gm)])
    .map((match) => match[1]);
  if (floors.length !== 1) throw new Error("missing or ambiguous Darwin deployment command");
  const normalize = (version) => version.split(".").map(Number).concat([0, 0]).slice(0, 3).join(".");
  if (normalize(floors[0]) !== normalize(expected)) {
    throw new Error(`Darwin ${architecture} minimum changed: ${floors[0]} (expected ${expected})`);
  }
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , artifact, architecture] = process.argv;
  if (!artifact || !architecture || process.argv.length !== 4) throw new Error("usage: check-darwin-minos.mjs <artifact> <arm64|x64>");
  if (process.platform !== "darwin" || process.arch !== architecture) throw new Error("run with the matching Darwin Node architecture");
  const machine = architecture === "x64" ? "x86_64" : "arm64";
  const actual = execFileSync("lipo", ["-archs", artifact], { encoding: "utf8" }).trim();
  if (actual !== machine) throw new Error(`unexpected Mach-O architecture: ${actual}`);
  const floor = assertDarwinMinos(execFileSync("xcrun", ["vtool", "-show-build", artifact], { encoding: "utf8" }), architecture);
  execFileSync("arch", [`-${machine}`, process.execPath, "-e", "require(require('node:path').resolve(process.argv[1]))", artifact], { stdio: "inherit" });
  console.log(`Verified ${architecture} binding load; macOS deployment target ${floor}`);
}
