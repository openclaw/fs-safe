param(
  [string] $RootProcessId,
  [string] $StartedAfter,
  [string] $StartedBefore,
  [ValidateSet('node.exe', 'powershell.exe')]
  [string] $RootProcessName = 'powershell.exe'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$snapshotClock = [Diagnostics.Stopwatch]::StartNew()
$snapshotCutoff = [DateTime]::UtcNow
$processLimit = 16
$script:snapshotErrors = @()
$script:snapshotProcesses = @()
$script:rootValidated = $false
$script:snapshotTruncated = $false
$processProperties = @(
  'Name', 'ProcessId', 'ParentProcessId', 'CreationDate',
  'KernelModeTime', 'UserModeTime', 'ThreadCount', 'WorkingSetSize'
)

function Add-SnapshotError([string] $Code, [string] $Category) {
  if ($script:snapshotErrors.Count -ge 8) { return }
  $script:snapshotErrors += @{ code = $Code; category = $Category }
}

function Get-CreationUtc($Process) {
  if ($Process.CreationDate -isnot [DateTime]) { return $null }
  return $Process.CreationDate.ToUniversalTime()
}

function Get-ProcessRows([string] $Filter, [int] $Maximum) {
  Get-CimInstance -ClassName Win32_Process -Filter $Filter -Property $processProperties -OperationTimeoutSec 1 |
    Select-Object -First $Maximum
}

function Add-ProcessFacts($Process, [DateTime] $CreatedUtc) {
  $name = [string] $Process.Name
  if ($name.Length -gt 128 -or $name -match '[\\/:\x00-\x1f]') {
    $name = 'invalid-process-name'
  }
  $script:snapshotProcesses += @{
    name = $name
    pid = [uint32] $Process.ProcessId
    parentPid = [uint32] $Process.ParentProcessId
    createdUtc = $CreatedUtc.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    kernelModeTime100ns = [string] $Process.KernelModeTime
    userModeTime100ns = [string] $Process.UserModeTime
    threadCount = [uint32] $Process.ThreadCount
    workingSetBytes = [string] $Process.WorkingSetSize
  }
}

function Get-OwnedProcessSnapshot {
  $requestedPid = [uint32] 0
  if (-not [uint32]::TryParse($RootProcessId, [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture, [ref] $requestedPid) -or $requestedPid -eq 0) {
    Add-SnapshotError 'invalid-root-process-id' 'InvalidArgument'
    return
  }
  $afterTime = [DateTimeOffset]::MinValue
  $beforeTime = [DateTimeOffset]::MinValue
  if ($StartedAfter -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$' -or
      -not [DateTimeOffset]::TryParse($StartedAfter, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AdjustToUniversal, [ref] $afterTime) -or
      $StartedBefore -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$' -or
      -not [DateTimeOffset]::TryParse($StartedBefore, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AdjustToUniversal, [ref] $beforeTime) -or
      $beforeTime -lt $afterTime -or $afterTime.UtcDateTime -gt $snapshotCutoff -or
      $beforeTime.UtcDateTime -gt $snapshotCutoff.AddSeconds(2)) {
    Add-SnapshotError 'invalid-creation-interval' 'InvalidArgument'
    return
  }

  $roots = @(Get-ProcessRows ('ProcessId = ' + $requestedPid) 2)
  if ($roots.Count -ne 1) {
    Add-SnapshotError 'root-unavailable' 'ObjectNotFound'
    return
  }
  $root = $roots[0]
  $rootCreated = Get-CreationUtc $root
  if ([uint32] $root.ProcessId -ne $requestedPid -or
      [string] $root.Name -ine $RootProcessName -or $null -eq $rootCreated -or
      $rootCreated -lt $afterTime.UtcDateTime -or $rootCreated -gt $beforeTime.UtcDateTime -or
      $rootCreated -gt $snapshotCutoff) {
    Add-SnapshotError 'root-identity-mismatch' 'InvalidData'
    return
  }

  $script:rootValidated = $true
  Add-ProcessFacts $root $rootCreated
  $seen = @{ ([string] $requestedPid) = $rootCreated }
  $frontier = @($requestedPid)
  while ($frontier.Count -gt 0) {
    if ($snapshotClock.ElapsedMilliseconds -ge 2400) {
      $script:snapshotTruncated = $true
      Add-SnapshotError 'snapshot-time-budget' 'OperationTimeout'
      return
    }
    $filter = ($frontier | ForEach-Object { 'ParentProcessId = ' + $_ }) -join ' OR '
    $remaining = $processLimit - $script:snapshotProcesses.Count
    $children = @(Get-ProcessRows $filter ($remaining + 1))
    $next = @()
    foreach ($child in $children) {
      $childPid = [uint32] $child.ProcessId
      $parentKey = [string] $child.ParentProcessId
      $created = Get-CreationUtc $child
      if ($childPid -eq 0 -or $seen.ContainsKey([string] $childPid) -or
          -not $seen.ContainsKey($parentKey)) { continue }
      # A fixed cutoff excludes processes born after a captured ancestor PID is reused.
      if ($null -eq $created -or $created -lt $seen[$parentKey] -or $created -gt $snapshotCutoff) { continue }
      if ($script:snapshotProcesses.Count -ge $processLimit) {
        $script:snapshotTruncated = $true
        return
      }
      $seen[[string] $childPid] = $created
      Add-ProcessFacts $child $created
      $next += $childPid
    }
    if ($children.Count -gt $remaining) {
      $script:snapshotTruncated = $true
      return
    }
    $frontier = @($next)
  }
}

try {
  Get-OwnedProcessSnapshot
} catch {
  Add-SnapshotError 'process-snapshot-failed' ([string] $_.CategoryInfo.Category)
}

$administrator = $null
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } finally {
    $identity.Dispose()
  }
} catch {
  Add-SnapshotError 'administrator-unavailable' ([string] $_.CategoryInfo.Category)
}

@{
  protocol = 1
  ok = $script:rootValidated -and $script:snapshotErrors.Count -eq 0
  rootValidated = $script:rootValidated
  truncated = $script:snapshotTruncated
  processes = @($script:snapshotProcesses)
  administrator = $administrator
  powerShellVersion = $PSVersionTable.PSVersion.ToString()
  languageMode = [string] $ExecutionContext.SessionState.LanguageMode
  errors = @($script:snapshotErrors)
} | ConvertTo-Json -Depth 5 -Compress
