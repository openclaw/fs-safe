param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
public static class CallbackAclFixture {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool SetFileSecurityW(string path, uint information, IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static void Set(string path, string sddl) {
    IntPtr descriptor; uint size;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out descriptor,out size))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      if(!SetFileSecurityW(path,0x80000004,descriptor))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { LocalFree(descriptor); }
  }
}
'@
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trueCondition = '(Member_of {SID(S-1-1-0)})'
$falseCondition = '(Member_of {SID(S-1-5-80-0)})'
$cases = @(
  @{name='read-true'; type='XA'; mask='0x001200A9'; flags='OICI'; condition=$trueCondition},
  @{name='read-false'; type='XA'; mask='0x001200A9'; flags='OICI'; condition=$falseCondition},
  @{name='read-inherited'; type='XA'; mask='0x001200A9'; flags='OICIID'; condition=$trueCondition},
  @{name='trusted-callback'; type='XA'; mask='0x001200A9'; flags=''; condition=$trueCondition; sid=$user},
  @{name='generic-read'; type='XA'; mask='GRGX'; flags=''; condition=$trueCondition},
  @{name='inherit-only'; type='XA'; mask='0x001200A9'; flags='OICIIO'; condition=$trueCondition},
  @{name='private-parent'; type='XA'; mask='0x001200A9'; flags='OICI'; condition=$trueCondition; sid=$user},
  @{name='write'; type='XA'; mask='0x00000002'; flags=''; condition=$trueCondition},
  @{name='generic-write'; type='XA'; mask='GW'; flags=''; condition=$falseCondition},
  @{name='write-dac'; type='XA'; mask='WD'; flags=''; condition=$trueCondition},
  @{name='write-owner'; type='XA'; mask='WO'; flags=''; condition=$trueCondition},
  @{name='delete'; type='XA'; mask='SD'; flags=''; condition=$trueCondition},
  @{name='deny'; type='XD'; mask='0x001200A9'; flags=''; condition=$trueCondition}
)
foreach ($case in $cases) {
  $target = Join-Path $Root $case.name
  $principal = if ($case.ContainsKey('sid')) { $case.sid } else { 'WD' }
  $sddl = "D:P(A;;FA;;;$user)(A;;FA;;;SY)($($case.type);$($case.flags);$($case.mask);;;$principal;$($case.condition))"
  [CallbackAclFixture]::Set($target, $sddl)
}
# The current user retains every file right except READ_DATA. A true callback
# grants that bit; the false callback must not. Cleanup retains WRITE_DAC.
$outcomes = @{}
foreach ($pair in @(@('kernel-true',$trueCondition), @('kernel-false',$falseCondition))) {
  $target = Join-Path $Root $pair[0]
  [CallbackAclFixture]::Set($target,"D:P(A;;0x001F01FE;;;$user)(XA;;0x00000001;;;WD;$($pair[1]))")
  try {
    $stream = [IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    $stream.Dispose()
    $outcomes[$pair[0]] = 'read-allowed'
  } catch [UnauthorizedAccessException] {
    $outcomes[$pair[0]] = 'read-denied'
  }
}
$outcomes | ConvertTo-Json -Compress
