import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isolatedConsumerEnv, resolvePnpmCommand } from "../scripts/consumer-install-smoke.mjs";

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "fs-safe pnpm lifecycle-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("runs the actual pnpm lifecycle at the repository's pinned version", () => {
  const directory = temporary();
  const [command, ...args] = resolvePnpmCommand();
  const version = execFileSync(command, [...args, "--version"], {
    cwd: directory, env: isolatedConsumerEnv(join(directory, "config")),
    encoding: "utf8", timeout: 10_000,
  }).trim();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(`pnpm@${version}`).toBe(pkg.packageManager);
});

it.each(["pnpm.js", "pnpm.cjs", "pnpm.mjs"])("runs the %s lifecycle script through the current runtime with intact arguments", (name) => {
  const directory = temporary();
  const cli = join(directory, name);
  writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)))");
  const command = resolvePnpmCommand(cli);
  expect(command).toEqual([process.execPath, realpathSync(cli)]);
  const output = execFileSync(command[0], [...command.slice(1), "argument with spaces"], {
    cwd: directory, env: isolatedConsumerEnv(join(directory, "config")), encoding: "utf8", timeout: 10_000,
  });
  expect(JSON.parse(output)).toEqual(["argument with spaces"]);
});

it.each(["pnpm-native", "pnpm-native.exe"])("recognizes the %s native Corepack lifecycle header", (name) => {
  const cli = join(temporary(), name);
  // This checks header classification; the real CLI execution is covered above.
  const header = Buffer.alloc(4);
  const descriptor = openSync(process.execPath, "r");
  try {
    expect(readSync(descriptor, header, 0, header.length, 0)).toBe(header.length);
  } finally {
    closeSync(descriptor);
  }
  writeFileSync(cli, header);
  expect(resolvePnpmCommand(cli)).toEqual([realpathSync(cli)]);
});

it("rejects absent lifecycle paths and shell/cmd launchers instead of searching PATH", () => {
  vi.stubEnv("npm_execpath", undefined);
  expect(() => resolvePnpmCommand()).toThrow("run pnpm package:collect or pnpm package:smoke");
  const directory = temporary();
  for (const name of ["pnpm", "pnpm.exe", "pnpm-native", "pnpm-native.exe", "pnpm.cmd", "npm-cli.js"]) {
    const launcher = join(directory, name);
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
    expect(() => resolvePnpmCommand(launcher)).toThrow("pnpm lifecycle CLI");
  }
  expect(() => resolvePnpmCommand("pnpm.mjs")).toThrow("pnpm lifecycle CLI");
  expect(() => resolvePnpmCommand(join(directory, "pnpm.mjs"))).toThrow("pnpm lifecycle CLI");
});

it("lets a caller override the package script's default output directory", () => {
  const directory = temporary();
  const first = join(directory, "default-artifacts");
  const last = join(directory, "requested-artifacts");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fixture-not-fs-safe" }));
  try {
    execFileSync("node", [resolve("scripts/check-release-packages.mjs"), "--output", first, "--output", last], {
      cwd: directory, env: { ...isolatedConsumerEnv(join(directory, "config")), npm_execpath: process.env.npm_execpath },
      encoding: "utf8", timeout: 10_000, stdio: "pipe",
    });
    expect.fail("the fixture must stop at package validation");
  } catch (error) {
    expect(error).toMatchObject({ status: 1 });
    expect(String((error as { stderr: string }).stderr)).toContain("unexpected package name fixture-not-fs-safe");
  }
  expect(existsSync(first)).toBe(false);
  expect(existsSync(last)).toBe(true);
});

it("rejects direct collection before creating artifacts when the lifecycle is absent", () => {
  const directory = temporary();
  const output = join(directory, "artifacts");
  try {
    execFileSync("node", ["scripts/check-release-packages.mjs", "--output", output], {
      env: isolatedConsumerEnv(join(directory, "config")), encoding: "utf8", timeout: 10_000, stdio: "pipe",
    });
    expect.fail("direct collection must reject a missing lifecycle CLI");
  } catch (error) {
    expect(error).toMatchObject({ status: 1 });
    expect(String((error as { stderr: string }).stderr)).toContain("run pnpm package:collect or pnpm package:smoke");
  }
  expect(existsSync(output)).toBe(false);
});
