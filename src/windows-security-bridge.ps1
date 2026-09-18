param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('path', 'descriptor', 'create')]
  [string] $Operation
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Avoid scanning unrelated installed modules before loading system cmdlets.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-security-bridge.cs')
$targetPath = [Environment]::GetEnvironmentVariable('FS_SAFE_WINDOWS_SECURITY_PATH')
[FsSafeWindowsBridge]::Execute($Operation, $targetPath) | ConvertTo-Json -Depth 8 -Compress
