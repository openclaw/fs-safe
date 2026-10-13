// Real lowbox process fixture. No capabilities: access comes only from the two
// explicitly named profiles on the shared fixture root.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class AppContainerFixture {
  [StructLayout(LayoutKind.Sequential)] struct Capabilities { public IntPtr Sid, CapabilitiesList; public uint Count, Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string path,int kind,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string text) { return "\""+text+"\""; }
  public static void AssertBaseline(string root) {
    string user;
    using(var identity=WindowsIdentity.GetCurrent()) user=identity.User.Value;
    foreach(string mode in new[]{"require","off"}) foreach(string thread in new[]{"main","worker"}) {
      string dir=Path.Combine(root,"ordinary-"+mode+"-"+thread);
      foreach(string path in new[]{dir,Path.Combine(dir,"file")}) {
        bool directory=path==dir;
        FileSystemSecurity security=directory ? (FileSystemSecurity)Directory.GetAccessControl(path,AccessControlSections.Access|AccessControlSections.Owner) : File.GetAccessControl(path,AccessControlSections.Access|AccessControlSections.Owner);
        var actual=new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(),0);
        string flags=directory ? "OICI" : "";
        var expected=new RawSecurityDescriptor("O:"+user+"D:P(A;"+flags+";FA;;;"+user+")(A;"+flags+";FA;;;SY)(A;"+flags+";FA;;;BA)");
        var left=new byte[actual.DiscretionaryAcl.BinaryLength]; actual.DiscretionaryAcl.GetBinaryForm(left,0);
        var right=new byte[expected.DiscretionaryAcl.BinaryLength]; expected.DiscretionaryAcl.GetBinaryForm(right,0);
        if(Convert.ToBase64String(left)!=Convert.ToBase64String(right) || !actual.Owner.Equals(expected.Owner) ||
          (actual.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) throw new Exception("Ordinary private DACL bytes changed");
      }
    }
  }
  public static void Run(string root) {
    string a="fs-safe-a-"+Guid.NewGuid().ToString("N"), b="fs-safe-b-"+Guid.NewGuid().ToString("N");
    IntPtr sidA=IntPtr.Zero,sidB=IntPtr.Zero;
    try {
      Marshal.ThrowExceptionForHR(CreateAppContainerProfile(a,a,a,IntPtr.Zero,0,out sidA));
      Marshal.ThrowExceptionForHR(CreateAppContainerProfile(b,b,b,IntPtr.Zero,0,out sidB));
      var security=Directory.GetAccessControl(root);
      foreach(var sid in new[]{sidA,sidB}) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      Directory.SetAccessControl(root,security);
      // Lowbox tokens must also pass Mandatory Integrity Control on the fixture.
      IntPtr label; uint size;
      Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;OICI;NW;;;LW)",1,out label,out size));
      try {
        bool present,defaulted; IntPtr sacl;
        Check(GetSecurityDescriptorSacl(label,out present,out sacl,out defaulted));
        uint error=SetNamedSecurityInfoW(root,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl);
        if(error!=0) throw new Win32Exception((int)error);
      } finally { LocalFree(label); }
      File.WriteAllText(Path.Combine(root,"profiles.json"),"[\""+new SecurityIdentifier(sidA).Value.ToLowerInvariant()+"\",\""+new SecurityIdentifier(sidB).Value.ToLowerInvariant()+"\"]");
      foreach(string mode in new[]{"require","off"}) {
        Launch(root,sidA,"create",mode);
        Launch(root,sidA,"reopen",mode);
        Launch(root,sidB,"deny",mode);
      }
    } finally {
      if(sidA!=IntPtr.Zero) { FreeSid(sidA); Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(a)); }
      if(sidB!=IntPtr.Zero) { FreeSid(sidB); Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(b)); }
    }
  }
  static void Launch(string root,IntPtr sid,string operation,string mode) {
    IntPtr size=IntPtr.Zero,list=IntPtr.Zero,caps=IntPtr.Zero;
    ProcessInfo process=new ProcessInfo();
    bool initialized=false;
    try {
      InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,1,0,ref size)); initialized=true;
      caps=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Capabilities)));
      Marshal.StructureToPtr(new Capabilities{Sid=sid},caps,false);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),caps,new IntPtr(Marshal.SizeOf(typeof(Capabilities))),IntPtr.Zero,IntPtr.Zero));
      var startup=new StartupEx(); startup.Startup.Size=(uint)Marshal.SizeOf(typeof(StartupEx)); startup.Attributes=list;
      string exe=Path.Combine(root,"node.exe");
      var command=new StringBuilder(Quote(exe)+" "+Quote(Path.Combine(root,"child.mjs"))+" "+operation+" "+mode);
      Check(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x80000,IntPtr.Zero,root,ref startup,out process));
      uint wait=WaitForSingleObject(process.Process,60000);
      if(wait!=0) { TerminateProcess(process.Process,1); throw new Exception("AppContainer child did not finish: "+wait); }
      uint code; Check(GetExitCodeProcess(process.Process,out code));
      if(code!=0) throw new Exception("AppContainer "+operation+"/"+mode+" exit "+code+": "+File.ReadAllText(Path.Combine(root,operation+"-"+mode+".json")));
    } finally {
      if(process.Thread!=IntPtr.Zero) CloseHandle(process.Thread);
      if(process.Process!=IntPtr.Zero) CloseHandle(process.Process);
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(caps!=IntPtr.Zero) Marshal.FreeHGlobal(caps);
    }
  }
}
