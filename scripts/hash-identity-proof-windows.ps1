#Requires -Version 7.0
# Runs prepared builds on one selected Windows runtime. No installs, builds, or Git writes.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaselineRepo,
    [Parameter(Mandatory)][string]$PatchedRepo,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$Work,
    [Parameter(Mandatory)][ValidateSet('22.23.2', '24.20.0')][string]$NodeVersion,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$PatchedCommit
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Both directories must be new. Never remove or reuse another invocation's receipts.
[void](New-Item -ItemType Directory -Path $Output)
[void](New-Item -ItemType Directory -Path $Work)
$Output = (Resolve-Path -LiteralPath $Output).Path
$Work = (Resolve-Path -LiteralPath $Work).Path
$summary = [ordered]@{
    startedAt = [DateTime]::UtcNow.ToString('o'); passed = $false
    baselineCommit = 'f8876aab64bca29d2a4f742c816ddd33ea8555cb'; patchedCommit = $PatchedCommit
    runs = [Collections.Generic.List[object]]::new()
    limitations = @('Baseline replacement admission is observational, never a security pass.',
        'Original historical event remains unattributed; all swaps here are controlled.',
        'Companion stats are additional non-atomic syscalls, not simultaneous identity samples.',
        'Raw V8 presence is not Vitest threshold evidence. Focused coverage is not repo-wide.',
        'Native is off in diagnostics. Mock-native tests prove dispatch only, not a real binding.')
}
function Write-Json([string]$File, [object]$Value) {
    $stream = [IO.File]::Open($File, [IO.FileMode]::CreateNew)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 60) + "`n")
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
function Invoke-Lane {
    param([string]$Label, [string]$Executable, [string[]]$Arguments,
        [string]$Directory, [int]$TimeoutSeconds = 90, [string]$RawCoverage = '')
    $lane = Join-Path $Output $Label
    [void](New-Item -ItemType Directory -Path $lane)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable; $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    [void]$start.Environment.Remove('NODE_V8_COVERAGE')
    if ($RawCoverage) { $start.Environment['NODE_V8_COVERAGE'] = $RawCoverage }
    $start.Environment['TEMP'] = $Work; $start.Environment['TMP'] = $Work
    $start.Environment['CI'] = '1'
    Write-Json (Join-Path $lane 'command.json') @{
        executable = $Executable; arguments = $Arguments; workingDirectory = $Directory
        timeoutSeconds = $TimeoutSeconds; rawV8Coverage = $RawCoverage
        temp = $Work; executableSha256 = (Get-FileHash -LiteralPath $Executable).Hash.ToLowerInvariant()
    }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $result = [ordered]@{ label = $Label; exitCode = $null; timedOut = $false; passed = $false }
    $stdout = ''; $stderr = ''
    try {
        if (-not $process.Start()) { throw 'Child did not start.' }
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $result.timedOut = $true
            $process.Kill($true)
            if (-not $process.WaitForExit(10000)) { throw 'Timed-out child did not exit after termination.' }
        }
        $stdout = $outTask.GetAwaiter().GetResult(); $stderr = $errTask.GetAwaiter().GetResult()
        $result.exitCode = $process.ExitCode
        $result.passed = $process.ExitCode -eq 0 -and -not $result.timedOut
    } catch { $result.error = $_.Exception.Message }
    finally {
        $process.Dispose()
        # Only this known command's output; never a workspace or environment dump.
        [IO.File]::WriteAllText((Join-Path $lane 'stdout.txt'), $stdout)
        [IO.File]::WriteAllText((Join-Path $lane 'stderr.txt'), $stderr)
        Write-Json (Join-Path $lane 'result.json') $result
        $summary.runs.Add($result)
    }
    Write-Host "$Label : exit=$($result.exitCode) timedOut=$($result.timedOut)"
    return [pscustomobject]@{ Result = $result; Stdout = $stdout; Lane = $lane }
}
function Invoke-Pnpm([string]$Label, [string[]]$Arguments) {
    # A fresh PowerShell process runs the installed pnpm shim, without assuming its packaging.
    # Quote each literal argument before encoding; no interpolation of shell expressions.
    $quoted = @($Arguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ' '
    $command = '$ErrorActionPreference = ''Stop''; & pnpm ' + $quoted + '; exit $LASTEXITCODE'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    return Invoke-Lane -Label $Label -Executable $script:pwsh -Directory $PatchedRepo -TimeoutSeconds 300 -Arguments @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
}
try {
    if (-not $IsWindows) { throw 'Requires real Windows; no platform adapters are permitted.' }
    if ([Environment]::GetEnvironmentVariable('NODE_OPTIONS')) {
        throw 'Inherited NODE_OPTIONS is nonempty; value withheld. Use a clean runner.'
    }
    $BaselineRepo = (Resolve-Path -LiteralPath $BaselineRepo).Path
    $PatchedRepo = (Resolve-Path -LiteralPath $PatchedRepo).Path
    if ($BaselineRepo -eq $PatchedRepo -or (Test-Path -LiteralPath (Join-Path $BaselineRepo '.git'))) {
        throw 'Baseline must be a separate archive, not a checkout or worktree.'
    }
    $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $script:pwsh = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
    $runtime = Invoke-Lane -Label 'runtime' -Executable $node -Directory $PatchedRepo -Arguments @(
        '-e', 'console.log(JSON.stringify({node:process.version,versions:process.versions,platform:process.platform,arch:process.arch}))')
    if (-not $runtime.Result.passed) { throw 'Runtime probe failed.' }
    $summary.runtime = $runtime.Stdout | ConvertFrom-Json
    if ($summary.runtime.platform -ne 'win32' -or $summary.runtime.arch -ne 'x64' -or
        $summary.runtime.node -ne "v$NodeVersion") { throw 'Expected the pinned native Windows x64 runtime.' }
    $pnpm = Invoke-Pnpm 'pnpm-version' @('--version')
    if (-not $pnpm.Result.passed -or $pnpm.Stdout.Trim() -ne '11.24.0') { throw 'Expected pnpm 11.24.0.' }
    # Selected fields only: no hostname, username, label, serial, or environment inventory.
    $facts = [ordered]@{
        powershell = $PSVersionTable.PSVersion.ToString()
        os = @(Get-CimInstance Win32_OperatingSystem -Property Caption, Version, BuildNumber, OSArchitecture |
            Select-Object Caption, Version, BuildNumber, OSArchitecture)
        volumes = [Collections.Generic.List[object]]::new()
    }
    $summary.filesystemFacts = $facts
    if ($facts.os.Count -ne 1 -or -not $facts.os[0].BuildNumber) { throw 'Missing Windows build observation.' }
    # Get-Volume receives an existing file at each measured location.
    foreach ($directory in @($Output, $Work)) {
        [void](New-Item -ItemType File -Path (Join-Path $directory 'volume-probe.bin'))
    }
    foreach ($location in @(@{ role = 'workspace'; path = $PatchedRepo; probe = 'package.json' },
        @{ role = 'baseline'; path = $BaselineRepo; probe = 'package.json' },
        @{ role = 'diagnostic-fixtures'; path = $Output; probe = 'volume-probe.bin' },
        @{ role = 'test-fixtures'; path = $Work; probe = 'volume-probe.bin' })) {
        $volume = @(Get-Volume -FilePath (Join-Path $location.path $location.probe) |
            Select-Object DriveLetter, @{ Name = 'FileSystemType'; Expression = { $_.FileSystemType.ToString() } },
                @{ Name = 'DriveType'; Expression = { $_.DriveType.ToString() } })
        if ($volume.Count -ne 1 -or -not $volume[0].FileSystemType -or $volume[0].FileSystemType -eq 'Unknown') {
            throw 'Expected a measured filesystem type for each proof location.'
        }
        $drive = [IO.Path]::GetPathRoot($location.path).TrimEnd('\')
        if ($drive -notmatch '^[A-Za-z]:$') { throw 'Proof inputs must use local drive paths.' }
        $logical = @(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'" -Property DeviceID, DriveType, FileSystem |
            Select-Object DeviceID, DriveType, FileSystem)
        if ($logical.Count -ne 1 -or -not $logical[0].FileSystem) { throw 'Missing logical-disk observation.' }
        $facts.volumes.Add(@{ role = $location.role; path = $location.path; getVolume = $volume; logicalDisk = $logical
            note = 'Get-Volume measures the path; LogicalDisk describes the drive root, not mounted subvolumes.' })
    }
    Write-Json (Join-Path $Output 'windows-filesystem.json') $facts
    $hashes = @{}
    foreach ($variant in @('baseline', 'patched')) {
        $repo = if ($variant -eq 'baseline') { $BaselineRepo } else { $PatchedRepo }
        $hashes[$variant] = (Get-FileHash -LiteralPath (Join-Path $repo 'dist/file-hash.js')).Hash.ToLowerInvariant()
    }
    if ($hashes.baseline -eq $hashes.patched) { throw 'Baseline and patched builds must differ.' }
    $summary.compiledSha256 = $hashes
    $summary.driverSha256 = (Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()
    $harness = Join-Path $PSScriptRoot 'hash-identity-proof.mjs'
    # All lanes are ordered and fresh processes, including after a diagnostic failure.
    foreach ($variant in @('baseline', 'patched')) {
        $repo = if ($variant -eq 'baseline') { $BaselineRepo } else { $PatchedRepo }
        $commit = if ($variant -eq 'baseline') { $summary.baselineCommit } else { $PatchedCommit }
        foreach ($mode in @('plain', 'raw-v8')) {
            $label = "$variant-$mode"
            $diagnostic = Join-Path $Output "$label-receipts"
            $raw = if ($mode -eq 'raw-v8') { Join-Path $Work "$label-raw" } else { '' }
            $run = Invoke-Lane -Label $label -Executable $node -Directory $repo -RawCoverage $raw -Arguments @(
                $harness, '--repo', $repo, '--output', $diagnostic, '--variant', $variant,
                '--source-ref', $commit, '--compiled-sha256', $hashes[$variant], '--require-windows', '--include-unscoped')
            if ($raw) {
                $audit = @{ label = "$label-presence"; passed = $false; rawV8Only = $true; vitestThresholdGate = $false }
                try {
                    $selected = @()
                    $preflight = Get-Content -LiteralPath (Join-Path $diagnostic 'preflight.json') -Raw | ConvertFrom-Json
                    $expectedUrl = $preflight.importedHashModuleUrl
                    if (-not $expectedUrl) { throw 'Missing imported module URL.' }
                    foreach ($file in @(Get-ChildItem -LiteralPath $raw -Filter '*.json' -File)) {
                        $data = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
                        $modules = @($data.result | Where-Object { $_.url -ceq $expectedUrl })
                        if ($modules.Count) {
                            $selected += @{ rawFile = $file.Name; rawSha256 = (Get-FileHash $file.FullName).Hash.ToLowerInvariant()
                                result = $modules }
                        }
                    }
                    $audit.passed = $run.Result.passed -and $selected.Count -gt 0
                    $audit.selectedModules = $selected
                    $audit.note = 'Only the exact imported dist/file-hash.js entry is retained; other raw V8 entries are not uploaded.'
                } catch { $audit.error = $_.Exception.Message }
                Write-Json (Join-Path $Output "$label-presence.json") $audit
                $summary.runs.Add($audit)
            }
        }
    }
    $tests = @('test/file-hash.test.ts', 'test/file-hash-identity.test.ts')
    $plainArguments = @('run', 'test') + $tests + @('--maxWorkers=1', '--no-file-parallelism')
    $plain = Invoke-Pnpm 'focused-tests-plain' $plainArguments
    $reports = Join-Path $Work 'focused-coverage'
    $coverageArguments = @('run', 'test:coverage') + $tests + @('--maxWorkers=1', '--no-file-parallelism',
        '--coverage.include=src/file-hash.ts', '--coverage.reporter=json-summary', "--coverage.reportsDirectory=$reports")
    $covered = Invoke-Pnpm 'focused-tests-coverage' $coverageArguments
    $gate = @{ label = 'focused-coverage-audit'; passed = $false; scope = 'src/file-hash.ts only, not repo-wide'
        required = @{ lines = 85; functions = 84.9; statements = 85; branches = 76 }
        plainArguments = $plainArguments; coverageArguments = $coverageArguments }
    try {
        $reportPath = Join-Path $reports 'coverage-summary.json'
        $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json -AsHashtable
        Copy-Item -LiteralPath $reportPath -Destination (Join-Path $Output 'focused-coverage-summary.json')
        $keys = @($report.Keys | Where-Object { $_ -ne 'total' })
        $target = (Join-Path $PatchedRepo 'src/file-hash.ts').Replace('\', '/')
        $gate.files = $keys
        $gate.passed = $covered.Result.passed -and $keys.Count -eq 1 -and $keys[0].Replace('\', '/') -eq $target
        foreach ($key in @('total') + $keys) {
            foreach ($metric in $gate.required.Keys) {
                $value = $report[$key][$metric]
                if ($null -eq $value -or $value.total -le 0 -or $value.pct -isnot [ValueType] -or
                    [double]::IsNaN([double]$value.pct) -or $value.pct -lt $gate.required[$metric]) { $gate.passed = $false }
            }
        }
        # Audit the unchanged config as well as measured coverage: no lowered configured thresholds.
        $config = Get-Content -LiteralPath (Join-Path $PatchedRepo 'vitest.config.ts') -Raw
        $block = [regex]::Match($config, '(?s)thresholds:\s*\{([^}]+)\}')
        if (-not $block.Success) { $gate.passed = $false }
        foreach ($metric in $gate.required.Keys) {
            $match = [regex]::Match($block.Groups[1].Value, "\b${metric}:\s*([0-9.]+)\s*,")
            if (-not $match.Success -or [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture) -ne
                $gate.required[$metric]) { $gate.passed = $false }
        }
    } catch { $gate.passed = $false; $gate.error = $_.Exception.Message }
    Write-Json (Join-Path $Output 'focused-coverage-audit.json') $gate
    $summary.runs.Add($gate)
    $summary.compiledUnchanged = (
        (Get-FileHash -LiteralPath (Join-Path $BaselineRepo 'dist/file-hash.js')).Hash.ToLowerInvariant() -eq $hashes.baseline -and
        (Get-FileHash -LiteralPath (Join-Path $PatchedRepo 'dist/file-hash.js')).Hash.ToLowerInvariant() -eq $hashes.patched)
    $summary.passed = $summary.compiledUnchanged -and @($summary.runs | Where-Object { -not $_.passed }).Count -eq 0
} catch { $summary.error = $_.Exception.Message }
finally {
    $summary.finishedAt = [DateTime]::UtcNow.ToString('o')
    Write-Json (Join-Path $Output 'driver-summary.json') $summary
}
if (-not $summary.passed) { exit 1 }
