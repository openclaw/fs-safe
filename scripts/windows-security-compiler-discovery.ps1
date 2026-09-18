param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$ConfiguredTemp
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$clock=[Diagnostics.Stopwatch]::StartNew()
function Write-ControlPhase([string]$phase) {
  try { [Console]::Error.WriteLine('FS_SAFE_COMPILER_CONTROL:'+$phase+':'+$clock.ElapsedMilliseconds) } catch {}
}
Write-ControlPhase 'script:start'
Write-ControlPhase 'command-discovery:start'
$command=Get-Command Add-Type -CommandType Cmdlet -ErrorAction Stop
Write-ControlPhase 'command-discovery:end'
Write-ControlPhase 'source-read:start'
$sourceBytes=[IO.File]::ReadAllBytes($SourcePath).Length
Write-ControlPhase 'source-read:end'
Write-ControlPhase 'runtime-facts:start'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try {
  $principal=[Security.Principal.WindowsPrincipal]::new($identity)
  $administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} finally { $identity.Dispose() }
$separators=[char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd($separators)
$expected=[IO.Path]::GetFullPath($ConfiguredTemp).TrimEnd($separators)
Write-ControlPhase 'runtime-facts:end'
@{
  commandFound=$true
  moduleName=$command.ModuleName
  moduleVersion=$command.Module.Version.ToString()
  sourceReadable=$true
  sourceBytes=$sourceBytes
  tempSpellingMatchesConfigured=[String]::Equals($temp,$expected,[StringComparison]::OrdinalIgnoreCase)
  administrator=$administrator
  languageMode=[string]$ExecutionContext.SessionState.LanguageMode
  powerShellVersion=$PSVersionTable.PSVersion.ToString()
  frameworkVersion=[Environment]::Version.ToString()
} | ConvertTo-Json -Compress
