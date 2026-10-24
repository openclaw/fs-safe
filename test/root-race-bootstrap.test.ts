import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(path: string, source: string) {
  writeFileSync(path, `#!/bin/bash\nset -eu\n${source}\n`, { mode: 0o755 });
}

function nodeFixture(version: string) {
  return `case "\${1:-}" in
  --version) echo v${version} ;;
  -e) exit 0 ;;
  *) printf 'node ${version} %s\\n' "$*" >> "$BOOTSTRAP_LOG" ;;
esac`;
}

function pnpmFixture(version: string) {
  return `if [ "\${1:-}" = --version ]; then
  printf 'pnpm identity ${version} %s\\n' "\${pnpm_config_pm_on_fail:-}" >> "$BOOTSTRAP_LOG"
  if [ "${version}" != 12.15.0 ] && [ "\${pnpm_config_pm_on_fail:-}" != ignore ]; then echo 12.15.0;
  else echo ${version}; fi
else printf 'pnpm ${version} %s\\n' "$*" >> "$BOOTSTRAP_LOG"; fi`;
}

const platforms = [
  { system: "Linux", machine: "x86_64", target: "linux-x64" },
  { system: "Linux", machine: "aarch64", target: "linux-arm64" },
  { system: "Darwin", machine: "arm64", target: "darwin-arm64" },
  { system: "Darwin", machine: "x86_64", target: "darwin-x64" },
];

it.skipIf(process.platform === "win32").each(
  platforms.flatMap((platform) => [
    { ...platform, label: "replaces installed vulnerable tools", node: "24.21.0", pnpm: "12.10.1", installs: true },
    { ...platform, label: "reuses the selected fixed tools", node: "24.22.1", pnpm: "12.15.0", installs: false },
  ]),
)("root-race bootstrap $system/$machine $label", ({ node, pnpm, installs, system, machine, target }) => {
  const directory = mkdtempSync(join(tmpdir(), "fs-safe bootstrap-"));
  directories.push(directory);
  const home = join(directory, "home");
  const bin = join(home, ".local", "bin");
  const archiveRoot = join(directory, `node-v24.22.1-${target}`);
  for (const path of [bin, home, join(archiveRoot, "bin")]) mkdirSync(path, { recursive: true });
  executable(join(bin, "node"), nodeFixture(node));
  executable(join(bin, "pnpm"), pnpmFixture(pnpm));
  executable(join(archiveRoot, "bin", "node"), nodeFixture("24.22.1"));
  const fixedPnpm = join(directory, "fixed-pnpm");
  executable(fixedPnpm, pnpmFixture("12.15.0"));
  const archive = `node-v24.22.1-${target}.tar.gz`;
  execFileSync("tar", ["-czf", join(directory, archive), "-C", directory, `node-v24.22.1-${target}`]);
  const digest = createHash("sha256").update(readFileSync(join(directory, archive))).digest("hex");
  writeFileSync(join(directory, "SHASUMS256.txt"), `${digest}  ${archive}\n`);
  executable(join(bin, "uname"), `if [ "$1" = -s ]; then echo ${system}; else echo ${machine}; fi`);
  executable(join(bin, "curl"), `
printf 'curl %s\\n' "$*" >> "$BOOTSTRAP_LOG"
case "\${@: -1}" in
  https://nodejs.org/dist/v24.22.1/SHASUMS256.txt) cp "$BOOTSTRAP_FIXTURE/SHASUMS256.txt" . ;;
  https://nodejs.org/dist/v24.22.1/${archive}) cp "$BOOTSTRAP_FIXTURE/${archive}" . ;;
  *) exit 42 ;;
esac`);
  executable(join(bin, "npm"), `
printf 'npm %s\\n' "$*" >> "$BOOTSTRAP_LOG"
[ "$*" = "install -g pnpm@12.15.0 --prefix $HOME/.local" ]
mkdir -p "$HOME/.local/bin"
cp "$BOOTSTRAP_FIXED_PNPM" "$HOME/.local/bin/pnpm"`);
  const log = join(directory, "calls.log");
  const output = execFileSync("bash", ["scripts/root-race/bootstrap-posix.sh"], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BOOTSTRAP_LOG: log,
      BOOTSTRAP_FIXTURE: directory,
      BOOTSTRAP_FIXED_PNPM: fixedPnpm,
    },
  });
  expect(output).toContain("v24.22.1\n12.15.0\n");
  const calls = readFileSync(log, "utf8");
  expect(calls).toContain("pnpm 12.15.0 install --frozen-lockfile");
  expect(calls).toContain("node 24.22.1 scripts/root-race/run.mjs");
  expect(calls.includes("curl ")).toBe(installs);
  expect(calls.includes("npm install ")).toBe(installs);
});
