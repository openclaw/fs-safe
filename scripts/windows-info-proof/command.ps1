param([Parameter(Mandatory)][string]$Request)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $false
$item = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
if (!(Test-Path -LiteralPath $item.executable -PathType Leaf)) { throw 'Command executable missing' }
Set-Location -LiteralPath $item.cwd
$commandArguments = [string[]]@($item.arguments)
& $item.executable @commandArguments
if ($LASTEXITCODE -isnot [int]) { throw 'Command lacks terminal integer exit status' }
exit $LASTEXITCODE
