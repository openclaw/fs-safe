param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('path', 'paths', 'descriptor', 'create', 'directory', 'protect-file', 'verify-file')]
  [string] $Operation
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Avoid scanning unrelated installed modules before loading system cmdlets.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Microsoft.PowerShell.Utility\Add-Type -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'windows-security-bridge.cs'))
if ($Operation -eq 'paths') {
  try {
    $inputStream = [Console]::OpenStandardInput()
    $inputBytes = [IO.MemoryStream]::new()
    try {
      $buffer = [byte[]]::new(8192)
      while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($inputBytes.Length + $read -gt 16 * 1024 * 1024) {
          throw 'Windows security path batch exceeds the input budget'
        }
        $inputBytes.Write($buffer, 0, $read)
      }
      $inputJson = [Text.UTF8Encoding]::new($false, $true).GetString($inputBytes.ToArray())
    } finally {
      $inputBytes.Dispose()
      $inputStream.Dispose()
    }
    if (-not $inputJson.TrimStart().StartsWith('[')) {
      throw 'Windows security paths must be a JSON array'
    }
    # Validate the whole document before wrapping it; the wrapper keeps empty,
    # singleton, and nested arrays intact on Windows PowerShell 5.1.
    $null = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $inputJson
    $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ('{"paths":' + $inputJson + '}')
    if ($request.paths -isnot [array]) {
      throw 'Windows security paths must be a JSON array'
    }
    $paths = [string[]]::new($request.paths.Length)
    for ($index = 0; $index -lt $request.paths.Length; $index++) {
      $value = $request.paths[$index]
      if ($value -isnot [string] -or $value.Length -eq 0 -or $value.IndexOf([char]0) -ge 0) {
        throw 'Windows security paths must be nonempty strings without NUL bytes'
      }
      $paths[$index] = $value
    }
    $reply = [FsSafeWindowsBridge]::ExecutePaths($paths)
  } catch {
    $reply = @{ ok = $false; code = 'EINVAL'; message = 'Invalid Windows security path batch' }
  }
} else {
  $targetPath = [Environment]::GetEnvironmentVariable('FS_SAFE_WINDOWS_SECURITY_PATH')
  $reply = [FsSafeWindowsBridge]::Execute($Operation, $targetPath)
}
$reply | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 8 -Compress
