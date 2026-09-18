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
    if ($requestBytes.Length -gt 1048576) { throw 'Windows move fixture request exceeds its input budget' }
  }
  $request = ConvertFrom-Json ($utf8.GetString($requestBytes.ToArray()))
} finally {
  $requestBytes.Dispose()
  $inputStream.Dispose()
}
if ($null -eq $request -or $request -is [Array] -or $request.operation -isnot [string]) {
  throw 'Windows move fixture request has an invalid operation'
}

$result = $null
switch -CaseSensitive ($request.operation) {
  'file-acl' {
    if ($request.path -isnot [string] -or $request.restricted -isnot [bool]) {
      throw 'Windows file ACL fixture requires a path and restriction flag'
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    # Restoring the DACL needs the owner's implicit WRITE_DAC, not WRITE_OWNER.
    if ($request.restricted) { $acl.SetOwner($sid) }
    $acl.SetAccessRuleProtection($true, $false)
    if ($request.restricted) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [Security.AccessControl.FileSystemRights]7, [Security.AccessControl.AccessControlType]::Deny
      ))
      $rights = 0x00130180
    } else {
      $rights = 0x001f01ff
    }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $sid, [Security.AccessControl.FileSystemRights]$rights, [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.File]::SetAccessControl($request.path, $acl)
  }
  'error-map' {
    if ($request.moveSource -isnot [string] -or
        $request.cases -isnot [Array]) {
      throw 'Windows error-map fixture requires source paths and cases'
    }
    Add-Type -LiteralPath $request.moveSource
    $flags = [Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static
    $move = [FsSafeWindowsMoveBridge].GetMethod('MoveOsFailure', $flags)
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($entry in $request.cases) {
      $number = [uint32]$entry[0]
      $rows.Add($number)
      $rows.Add($move.Invoke($null, @($number, 'probe', $false)).Code)
      $rows.Add($move.Invoke($null, @($number, 'probe', $true)).Code)
    }
    $result = @{
      rows = $rows.ToArray()
    }
  }
  'remove-tree' {
    if ($request.path -isnot [string]) { throw 'Windows tree cleanup fixture requires a path' }
    if ([IO.Directory]::Exists($request.path)) { [IO.Directory]::Delete($request.path, $true) }
  }
  'rename-statuses' {
    if ($request.moveSource -isnot [string] -or
        $request.cases -isnot [Array]) {
      throw 'Windows rename-status fixture requires source paths and cases'
    }
    Add-Type -LiteralPath $request.moveSource
    $rows = [Collections.Generic.List[object]]::new()
    $move = $request.move
    foreach ($entry in $request.cases) {
      [Environment]::SetEnvironmentVariable('FS_SAFE_MOVE_TEST_NTSTATUS', [string]$entry.ntStatus)
      $rows.Add([FsSafeWindowsMoveBridge]::ExecuteMove(
        $move.rootPath, $move.rootIdentity,
        $move.sourceParentPath, $move.sourceRelative, $move.sourceParentIdentity,
        $move.sourceName, $move.sourceIdentity,
        $move.targetParentPath, $move.targetRelative, $move.targetParentIdentity, $move.targetName
      ))
    }
    $result = $rows.ToArray()
  }
  default { throw 'Windows move fixture request has an invalid operation' }
}
if ($null -ne $result) {
  [Console]::OutputEncoding = $utf8
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
}
