import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("admits only the selected Windows capacity and rejects invalid floors", () => {
  const windows = { Windows: true, Architecture: "X64", RunnerOS: "Windows", LogicalProcessors: 16 };
  const cases = [
    { name: "default 16-core host", parameters: windows, accepted: true },
    { name: "default refuses four cores", parameters: { ...windows, LogicalProcessors: 4 }, accepted: false },
    { name: "qualified four-core host", parameters: { ...windows, LogicalProcessors: 4, MinimumLogicalProcessors: "4" }, accepted: true },
    { name: "larger qualified host", parameters: { ...windows, MinimumLogicalProcessors: "4" }, accepted: true },
    { name: "insufficient qualified host", parameters: { ...windows, LogicalProcessors: 3, MinimumLogicalProcessors: "4" }, accepted: false },
    { name: "non-Windows host", parameters: { ...windows, Windows: false, MinimumLogicalProcessors: "4" }, accepted: false },
    { name: "emulated architecture", parameters: { ...windows, Architecture: "Arm64", MinimumLogicalProcessors: "4" }, accepted: false },
    { name: "wrong runner context", parameters: { ...windows, RunnerOS: "Linux", MinimumLogicalProcessors: "4" }, accepted: false },
    ...["", "0", "1", "8", "-1", "04", "+4", "4.0", "4.5", "four"].map((floor) => ({
      name: `invalid floor ${JSON.stringify(floor)}`,
      parameters: { ...windows, MinimumLogicalProcessors: floor },
      accepted: false,
    })),
  ];
  // Execute the admission function itself; the action separately supplies fresh
  // RuntimeInformation/CIM facts, rather than trusting these fixture values.
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    . $env:FS_SAFE_RUNNER_CHECK
    $results = foreach ($case in (ConvertFrom-Json $env:FS_SAFE_RUNNER_CASES)) {
      $parameters = @{}
      foreach ($property in $case.parameters.PSObject.Properties) {
        $parameters[$property.Name] = $property.Value
      }
      try {
        Assert-FsSafeWindowsCiRunner @parameters
        @{ name = $case.name; accepted = $true }
      } catch {
        @{ name = $case.name; accepted = $false }
      }
    }
    ConvertTo-Json -Compress -InputObject @($results)
  `], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      FS_SAFE_RUNNER_CHECK: resolve(".github/actions/verify-windows-ci-runner/verify-runner.ps1"),
      FS_SAFE_RUNNER_CASES: JSON.stringify(cases),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(cases.map(({ name, accepted }) => ({ name, accepted })));
}, 15_000);
