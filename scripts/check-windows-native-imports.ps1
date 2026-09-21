#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$ConsumerProof,
    [Parameter(Mandatory)][string]$Output
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows PE verification requires Windows.' }
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$binaryHash = (Get-FileHash -LiteralPath $Binary -Algorithm SHA256).Hash.ToLowerInvariant()
$proof = Get-Content -LiteralPath $ConsumerProof -Raw | ConvertFrom-Json
if ($proof.source.dirty -ne $false -or $proof.source.commit -ne $proof.expectedSourceCommit) {
    throw 'Consumer proof must identify a clean expected source commit.'
}
foreach ($managerName in @('npm', 'pnpm')) {
    $manager = @($proof.managers | Where-Object { $_.manager -eq $managerName })
    if ($manager.Count -ne 1) { throw "Missing unique $managerName consumer proof." }
    $normal = @($manager[0].cases | Where-Object { $_.omitted -eq $false })
    if ($normal.Count -ne 1) { throw "Missing unique $managerName normal install." }
    $native = @($normal[0].windowsSecurity | Where-Object { $_.mode -eq 'require' })
    if ($native.Count -ne 1) { throw "Missing unique $managerName required-native receipt." }
    $observed = $native[0]
    if ($observed.protocol -ne 2 -or $observed.platform -ne 'win32' -or $observed.arch -ne 'x64' -or
        $observed.nativeLoaded -ne $true -or $observed.binarySha256 -cne $binaryHash -or
        $observed.source.dirty -ne $false -or $observed.source.commit -ne $proof.source.commit -or
        $observed.source.tree -ne $proof.source.tree) {
        throw "Inspected binary does not match the loaded $managerName Windows consumer artifact."
    }
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$tools = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe')
if ($LASTEXITCODE -ne 0 -or $tools.Count -eq 0) { throw 'MSVC dumpbin is unavailable.' }
$dumpbin = $tools[0]
$headers = (& $dumpbin /nologo /headers $Binary) -join "`n"
if ($LASTEXITCODE -ne 0 -or $headers -notmatch '(?im)^\s*8664\s+machine\b' -or
    $headers -notmatch '(?im)^\s*20B\s+magic # \(PE32\+\)') { throw 'Expected an AMD64 PE32+ addon.' }
# The standard tool filters import descriptors to this DLL before symbol matching.
$imports = (& $dumpbin /nologo /imports:ntdll.dll $Binary) -join "`n"
if ($LASTEXITCODE -ne 0 -or $imports -notmatch '(?im)^\s*ntdll\.dll\s*$') {
    throw 'Could not inspect ntdll.dll imports.'
}
$symbols = @('NtCreateFile', 'NtSetInformationFile', 'NtReadFile', 'NtQueryInformationFile', 'RtlNtStatusToDosError')
foreach ($symbol in $symbols) {
    if (-not [regex]::IsMatch($imports, '(?m)^\s*[0-9A-Fa-f]+\s+' + [regex]::Escape($symbol) + '\s*$')) {
        throw "Missing ntdll.dll import: $symbol"
    }
}
if ((Get-FileHash -LiteralPath $Binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $binaryHash) {
    throw 'The inspected addon changed during verification.'
}
$receipt = @{ machine = 'AMD64 (0x8664)'; format = 'PE32+'; binarySha256 = $binaryHash; imports = @{ 'ntdll.dll' = $symbols } }
$Output = [IO.Path]::GetFullPath($Output)
[void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output))
[IO.File]::WriteAllText($Output, ($receipt | ConvertTo-Json -Depth 5) + "`n", [Text.UTF8Encoding]::new($false))
