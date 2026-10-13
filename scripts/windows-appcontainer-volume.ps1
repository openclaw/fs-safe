param([Parameter(Mandatory=$true)][string]$Node, [switch]$DiagnosticsOnly)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('fs-safe-appcontainer-volume-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$image = Join-Path $fixture 'appcontainer.vhd'
$letter = @('Z','Y','X','W','V','U','T','S','R') | Where-Object { -not (Test-Path ($_.ToString() + ':\')) } | Select-Object -First 1
if (-not $letter) { throw 'No unused drive letter for isolated AppContainer proof' }
$label = 'FSA' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$output = Join-Path $PSScriptRoot '../artifacts-appcontainer'
New-Item -ItemType Directory -Path $output -Force | Out-Null
function MarkPhase($phase) {
  $row = @{phase=$phase;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  [IO.File]::AppendAllText((Join-Path $output 'outer-volume.jsonl'), $row + [Environment]::NewLine)
  [Console]::WriteLine($row)
}
try {
  $setup = Join-Path $fixture 'setup.txt'
  @"
create vdisk file="$image" maximum=256 type=expandable
select vdisk file="$image"
attach vdisk
create partition primary
format fs=ntfs quick label=$label
assign letter=$letter
"@ | Set-Content -Path $setup -Encoding ascii
  MarkPhase 'volume-create:before'
  & diskpart.exe /s $setup | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Owned AppContainer volume setup failed' }
  $volume = Get-Volume -DriveLetter $letter
  if ($volume.FileSystemLabel -ne $label -or $volume.FileSystem -ne 'NTFS') { throw 'Owned AppContainer volume identity not established' }
  MarkPhase 'volume-create:after'
  # SetFileSecurity establishes a fresh protected baseline only on our disposable
  # volume. Host ancestors are untouched; the proof still asserts exact restoration.
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class AppContainerVolumeSecurity {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool SetFileSecurityW(string path, uint information, byte[] descriptor);
}
'@
  $drive = $letter + ':\'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor("D:P(A;OICI;FA;;;$sid)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
  $bytes = New-Object byte[] $descriptor.BinaryLength
  $descriptor.GetBinaryForm($bytes, 0)
  MarkPhase 'volume-acl:before'
  if (-not [AppContainerVolumeSecurity]::SetFileSecurityW($drive, [uint32]2147483652, $bytes)) {
    throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
  }
  MarkPhase 'volume-acl:after'
  $arguments = @((Join-Path $PSScriptRoot 'windows-appcontainer-proof.mjs'), '--volume-root', (Join-Path $drive 'fixture'))
  if ($DiagnosticsOnly) { $arguments += '--diagnostics-only' }
  MarkPhase 'proof:before'
  & $Node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'AppContainer proof failed' }
  MarkPhase 'proof:after'
} finally {
  if (Test-Path $image) {
    $teardown = Join-Path $fixture 'teardown.txt'
    @"
select vdisk file="$image"
detach vdisk
"@ | Set-Content -Path $teardown -Encoding ascii
    MarkPhase 'volume-detach:before'
    & diskpart.exe /s $teardown | Out-Host
    if ((Get-DiskImage -ImagePath $image).Attached) { throw 'Owned VHD remains attached; refusing fixture deletion' }
    MarkPhase 'volume-detach:after'
  }
  MarkPhase 'volume-temp-cleanup:before'
  Remove-Item -LiteralPath $fixture -Recurse -Force
  MarkPhase 'volume-temp-cleanup:after'
}
