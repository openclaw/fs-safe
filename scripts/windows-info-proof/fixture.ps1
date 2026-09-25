param(
    [Parameter(Mandatory)][ValidateSet('sparse','extent')][string]$Action,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$target = [IO.Path]::GetFullPath($Path)
if (!$target.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture path escapes admitted lane' }
for ($p = $target; $p.Length -ge $rootPath.Length; $p = [IO.Path]::GetDirectoryName($p)) {
    $item = Get-Item -LiteralPath $p -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture path contains a reparse entry' }
    if ($p -ceq $rootPath) { break }
    if (!$p.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture ancestor escaped' }
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WindowsInfoFixture {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern int DeviceIoControl(SafeFileHandle handle, uint code, [In] byte[] input, uint inputSize, [Out] byte[] output, uint outputSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetCompressedFileSizeW(string path, out uint high);
  public static long[] Inspect(string path, bool sparse) {
    using (var handle = CreateFileW(path, sparse ? 0x40000000u : 0x80000000u, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint returned;
      if (sparse) {
        if (DeviceIoControl(handle, 0x900c4, null, 0, null, 0, out returned, IntPtr.Zero) == 0)
          throw new Win32Exception(Marshal.GetLastWin32Error());
        return new long[] {0, 0};
      }
      byte[] input = new byte[8];
      byte[] output = new byte[512];
      if (DeviceIoControl(handle, 0x90073, input, 8, output, 512, out returned, IntPtr.Zero) == 0)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (returned < 32 || BitConverter.ToUInt32(output, 0) == 0) throw new Exception("Missing retrieval extent");
      long lcn = BitConverter.ToInt64(output, 24);
      if (lcn < 0) throw new Exception("Leading marker is not allocated");
      uint high;
      uint low = GetCompressedFileSizeW(path, out high);
      if (low == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
      return new long[] { lcn, ((long)high << 32) | low };
    }
  }
}
'@
$result = [WindowsInfoFixture]::Inspect($target, $Action -ceq 'sparse')
if ($result[1] -gt 16777216) { throw 'Sparse fixture exceeds allocated-byte cap' }
[ordered]@{ action=$Action; lcn=$result[0].ToString(); allocatedBytes=$result[1]; rawHandlesPassedToProduct=$false } | ConvertTo-Json -Compress
