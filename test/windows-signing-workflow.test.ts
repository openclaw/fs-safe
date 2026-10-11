import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const release = readFileSync(".github/workflows/release.yml", "utf8").replaceAll("\r\n", "\n");
function job(name: string) {
  const start = release.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(0);
  const next = release.slice(start + 1).search(/\n  [a-z][\w-]*:\n/);
  return next < 0 ? release.slice(start) : release.slice(start, start + 1 + next);
}

describe("release signing isolation", () => {
  it("keeps every publishing job disabled for manual dispatches", () => {
    for (const name of ["draft-release", "publish", "release"]) {
      expect(job(name)).toContain("if: github.event_name == 'push' && github.ref_protected");
    }
    expect(job("validate")).toContain("github.event_name == 'workflow_dispatch' && inputs.dry_run");
    const triggers = release.slice(0, release.indexOf("\npermissions:"));
    expect(triggers).not.toContain("pull_request:");
    expect(triggers).not.toContain("branches:");
    expect(triggers).toContain('tags:\n      - "v*.*.*"');
  });

  it("never requests the signing environment from PR or main-push CI", () => {
    for (const file of readdirSync(".github/workflows").filter((name) => name.endsWith(".yml") && name !== "release.yml")) {
      const workflow = readFileSync(`.github/workflows/${file}`, "utf8");
      expect(workflow, file).not.toMatch(/environment:\s*release-signing/);
      expect(workflow, file).not.toContain("./.github/workflows/release.yml");
    }
    expect(release.match(/environment: release-signing/g)).toHaveLength(1);
    expect(job("sign-windows")).toContain("needs: [prebuild, prebuild-helper]");
    expect(job("sign-windows")).toContain("runs-on: windows-latest");
    expect(job("sign-windows")).not.toContain("continue-on-error");
  });

  it("gates collection on signed runtime tests and preserves the publication artifact layout", () => {
    const test = job("test-signed-windows");
    expect(test).toContain("needs: sign-windows");
    expect(test).toContain("os: windows-latest");
    expect(test).toContain("os: windows-11-arm");
    expect(test).toContain("name: signed-windows");
    const collect = job("collect");
    expect(collect).toContain("needs: [prebuild, prebuild-freebsd, test-signed-windows]");
    expect(collect).toContain("pattern: binding-*");
    expect(job("prebuild")).toContain("&& 'unsigned-binding' || 'binding'");
    expect(collect).toContain("--windows-signing-manifest artifacts/signed-windows/windows-signing.json");
    expect(collect).toContain("path: release-artifacts/*");
    expect(collect.indexOf("run: pnpm build")).toBeLessThan(collect.indexOf("run: cp artifacts/signed-windows/windows-security-helper.exe"));
  });
});
