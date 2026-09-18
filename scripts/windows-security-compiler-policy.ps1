param([switch]$SystemModulesOnly)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($SystemModulesOnly){$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try {
  $principal=[Security.Principal.WindowsPrincipal]::new($identity)
  $administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} finally { $identity.Dispose() }
@{
  executionPolicy=[string](Get-ExecutionPolicy)
  languageMode=[string]$ExecutionContext.SessionState.LanguageMode
  administrator=$administrator
  processPolicyOverridePresent=($null -ne [Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference'))
  lockdownOverridePresent=($null -ne [Environment]::GetEnvironmentVariable('__PSLockdownPolicy'))
} | ConvertTo-Json -Compress
