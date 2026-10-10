param([string]$FilePath)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ClusterProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetDiskFreeSpaceW(string root, out uint sectors, out uint bytes, out uint free, out uint total);
}
'@
$root = [IO.Path]::GetPathRoot($FilePath)
[uint32]$sectors=0; [uint32]$bytes=0; [uint32]$free=0; [uint32]$total=0
if (![ClusterProbe]::GetDiskFreeSpaceW($root, [ref]$sectors, [ref]$bytes, [ref]$free, [ref]$total)) {
  throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
@{ clusterSize=([uint64]$sectors * $bytes); sectorsPerCluster=$sectors; bytesPerSector=$bytes;
   attributes=[int][IO.File]::GetAttributes($FilePath); filesystem=[IO.DriveInfo]::new($root).DriveFormat } | ConvertTo-Json -Compress
