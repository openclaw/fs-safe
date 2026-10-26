import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

function admission(platform: string, arch: string, minimum: string) {
  return spawnSync(process.execPath, ["scripts/check-ci-runtime.mjs", platform, arch, minimum], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

it("admits the selected stable runtime and reports its executable", () => {
  const result = admission(process.platform, process.arch, process.versions.node);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(process.execPath);
  expect(result.stdout).toContain(`Node ${process.versions.node}`);
});

it("refuses a runtime below the patched floor or outside the selected major", () => {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  for (const floor of [`${major}.${minor}.${patch! + 1}`, `${major! + 1}.0.0`]) {
    const result = admission(process.platform, process.arch, floor);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(process.execPath);
    expect(result.stderr).toContain("pkg upgrade the selected Node package");
    expect(result.stderr).toContain("do not continue native proof");
  }
});

it("preserves platform and architecture admission and rejects invalid floors", () => {
  for (const [platform, arch, floor] of [
    ["wrong-platform", process.arch, process.versions.node],
    [process.platform, "wrong-arch", process.versions.node],
    [process.platform, process.arch, "24.22.1-rc.1"],
    [process.platform, process.arch, "24"],
  ]) {
    const result = admission(platform!, arch!, floor!);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI runtime rejected");
  }
});
