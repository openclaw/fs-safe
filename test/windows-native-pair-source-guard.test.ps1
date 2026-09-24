param([string]$CapturedMapsDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourcePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/windows-native-pair.ps1'
$source = [IO.File]::ReadAllText($sourcePath)
$matches = [regex]::Matches($source, '(?ms)^    \$(?:baselinePaths|changed) =.*?(?=^    Save-Json ''inputs.json'')')
if ($matches.Count -ne 1) { throw 'Cannot isolate the actual source-delta guard' }
$guard = [ScriptBlock]::Create($matches[0].Value)
$expected = @('native/src/clone_windows.rs','native/src/copy_windows.rs','native/src/windows.rs','native/src/windows_security.rs')
$cases = [Collections.Generic.List[string]]::new()
function Check-Guard([string]$name, $baseline, $candidate, [bool]$shouldPass) {
    $before = @{ baseline=$baseline; candidate=$candidate }
    $passed = $true
    try { & $guard } catch {
        if ($_.Exception.Message -cne 'Unexpected source delta outside the four reviewed Rust files') { throw }
        $passed = $false
    }
    if ($passed -ne $shouldPass) { throw "Source guard case failed: $name; expected pass=$shouldPass, actual=$passed" }
    $cases.Add($name)
}
function Maps([string[]]$candidatePaths, [string[]]$changedPaths) {
    $baseline = [ordered]@{}; $candidate = [ordered]@{}
    foreach ($path in @($expected + 'shared.ts')) { $baseline[$path] = 'same' }
    foreach ($path in $candidatePaths) { $candidate[$path] = if ($changedPaths -ccontains $path) { 'different' } else { 'same' } }
    return @{ baseline=$baseline; candidate=$candidate }
}
$originalCulture = [Threading.Thread]::CurrentThread.CurrentCulture
try {
    foreach ($culture in @('en-US','de-DE','')) {
        [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::new($culture)
        $prefix = if ($culture) { $culture } else { 'invariant' }
        $map = Maps @($expected + 'shared.ts') $expected
        Check-Guard "$prefix/four-exact-paths" $map.baseline $map.candidate $true
        $reversed = @($expected + 'shared.ts'); [Array]::Reverse($reversed)
        $map = Maps $reversed $expected
        Check-Guard "$prefix/different-map-order" $map.baseline $map.candidate $true
        $map = Maps @($expected + 'shared.ts') $expected[0..2]
        Check-Guard "$prefix/missing-change" $map.baseline $map.candidate $false
        $map = Maps @($expected + 'shared.ts') @($expected + 'shared.ts')
        Check-Guard "$prefix/extra-change" $map.baseline $map.candidate $false
        $map = Maps @($expected + 'shared.ts' + 'extra.ts') $expected
        Check-Guard "$prefix/extra-candidate-path" $map.baseline $map.candidate $false
        $map = Maps $expected $expected
        Check-Guard "$prefix/missing-candidate-path" $map.baseline $map.candidate $false
        $caseChanged = @($expected + 'shared.ts') -creplace 'native/src/windows.rs','native/src/Windows.rs'
        $map = Maps $caseChanged $caseChanged[0..3]
        Check-Guard "$prefix/path-case-change" $map.baseline $map.candidate $false
        if ($CapturedMapsDirectory) {
            $baseline = (Get-Content (Join-Path $CapturedMapsDirectory 'baseline-source-before.json') -Raw | ConvertFrom-Json -AsHashtable).files
            $candidate = (Get-Content (Join-Path $CapturedMapsDirectory 'candidate-source-before.json') -Raw | ConvertFrom-Json -AsHashtable).files
            Check-Guard "$prefix/captured-run-maps" $baseline $candidate $true
        }
    }
} finally { [Threading.Thread]::CurrentThread.CurrentCulture = $originalCulture }
[ordered]@{ passed=$cases.Count; cases=$cases.ToArray(); guardSource=$sourcePath; productCalls=0; nativeBuilds=0; workflowDispatches=0 } | ConvertTo-Json -Depth 4
