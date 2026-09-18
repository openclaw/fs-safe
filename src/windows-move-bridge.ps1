$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$utf8 = [Text.UTF8Encoding]::new($false, $true)
$inputStream = [Console]::OpenStandardInput()
$requestBytes = [IO.MemoryStream]::new()
$buffer = New-Object byte[] 8192
try {
  while ($true) {
    $remaining = 1048577 - [int]$requestBytes.Length
    $count = $inputStream.Read($buffer, 0, [Math]::Min($buffer.Length, $remaining))
    if ($count -eq 0) { break }
    $requestBytes.Write($buffer, 0, $count)
    if ($requestBytes.Length -gt 1048576) { throw 'Windows move request exceeds its input budget' }
  }
  $request = ConvertFrom-Json ($utf8.GetString($requestBytes.ToArray()))
} finally {
  $requestBytes.Dispose()
  $inputStream.Dispose()
}
if ($null -eq $request -or $request -is [Array] -or $request.scope -cne 'root') {
  throw 'Windows move request has an invalid scope'
}

# Only this fixed package asset supplies executable source.
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-move-bridge.cs')
$result = [FsSafeWindowsMoveBridge]::ExecuteMove(
  $request.rootPath, $request.rootIdentity,
  $request.sourceParentPath, $request.sourceRelative, $request.sourceParentIdentity,
  $request.sourceName, $request.sourceIdentity,
  $request.targetParentPath, $request.targetRelative, $request.targetParentIdentity,
  $request.targetName
)
[Console]::OutputEncoding = $utf8
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
