import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isolatedConsumerEnv, resolvePnpmCli } from "../scripts/consumer-install-smoke.mjs";

const directories: string[] = [];
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "fs-safe-pnpm-lifecycle-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("uses the actual pnpm lifecycle JavaScript CLI", () => {
  expect(resolvePnpmCli()).toBe(realpathSync(process.env.npm_execpath!));
});

it("rejects absent lifecycle paths and shell/cmd launchers instead of searching PATH", () => {
  vi.stubEnv("npm_execpath", undefined);
  expect(() => resolvePnpmCli()).toThrow("run pnpm package:collect or pnpm package:smoke");
  const directory = temporary();
  for (const name of ["pnpm", "pnpm.cmd", "npm-cli.js"]) {
    const launcher = join(directory, name);
    writeFileSync(launcher, "not a pnpm JavaScript CLI");
    expect(() => resolvePnpmCli(launcher)).toThrow("pnpm lifecycle CLI");
  }
  expect(() => resolvePnpmCli("pnpm.mjs")).toThrow("pnpm lifecycle CLI");
  expect(() => resolvePnpmCli(join(directory, "pnpm.mjs"))).toThrow("pnpm lifecycle CLI");
});

it("rejects direct collection before creating artifacts when the lifecycle is absent", () => {
  const directory = temporary();
  const output = join(directory, "artifacts");
  try {
    execFileSync(process.execPath, ["scripts/check-release-packages.mjs", "--output", output], {
      env: isolatedConsumerEnv(join(directory, "config")), encoding: "utf8", timeout: 10_000, stdio: "pipe",
    });
    expect.fail("direct collection must reject a missing lifecycle CLI");
  } catch (error) {
    expect(error).toMatchObject({ status: 1 });
    expect(String((error as { stderr: string }).stderr)).toContain("run pnpm package:collect or pnpm package:smoke");
  }
  expect(existsSync(output)).toBe(false);
});
