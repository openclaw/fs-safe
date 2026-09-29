param([Parameter(Mandatory = $true)][int]$ProcessId)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

public static class WatchIdleThreads
{
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint WAIT_FAILED = 0xffffffff;

    public sealed class Sample
    {
        public int id;
        public string name;
        public string created;
        public ulong ticks;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenThread(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessIdOfThread(IntPtr thread);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern int GetThreadDescription(IntPtr thread, out IntPtr description);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetThreadTimes(IntPtr thread, out ulong created, out ulong exited, out ulong kernel, out ulong user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static bool IsRunning(IntPtr handle)
    {
        switch (WaitForSingleObject(handle, 0))
        {
            case WAIT_OBJECT_0: return false;
            case WAIT_TIMEOUT: return true;
            case WAIT_FAILED:
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
            default:
                throw new InvalidOperationException("Unexpected thread wait result");
        }
    }

    public static Sample[] Read(int processId)
    {
        var samples = new List<Sample>();
        using (var process = Process.GetProcessById(processId))
        {
            foreach (ProcessThread thread in process.Threads)
            {
                using (thread)
                {
                    // THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE: query and wait only.
                    IntPtr handle = OpenThread(0x00100800, false, (uint)thread.Id);
                    if (handle == IntPtr.Zero)
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == 87) continue; // The enumerated thread has already exited.
                        throw new Win32Exception(error, "OpenThread " + thread.Id);
                    }
                    try
                    {
                        if (!IsRunning(handle)) continue;
                        uint owner = GetProcessIdOfThread(handle);
                        if (owner == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetProcessIdOfThread");
                        if (owner != (uint)processId) continue; // A recycled id belongs to another process.
                        IntPtr description = IntPtr.Zero;
                        try
                        {
                            Marshal.ThrowExceptionForHR(GetThreadDescription(handle, out description));
                            ulong created, ignoredExitTime, kernel, user;
                            if (!GetThreadTimes(handle, out created, out ignoredExitTime, out kernel, out user))
                                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetThreadTimes");
                            if (!IsRunning(handle)) continue;
                            samples.Add(new Sample {
                                id = thread.Id,
                                name = Marshal.PtrToStringUni(description) ?? "",
                                // FILETIME exceeds JS's exact integer range; retain identity as text.
                                created = created.ToString(CultureInfo.InvariantCulture),
                                ticks = kernel + user
                            });
                        }
                        finally
                        {
                            if (description != IntPtr.Zero) LocalFree(description);
                        }
                    }
                    finally
                    {
                        CloseHandle(handle);
                    }
                }
            }
        }
        return samples.ToArray();
    }
}
'@

ConvertTo-Json -Compress -InputObject @([WatchIdleThreads]::Read($ProcessId))
