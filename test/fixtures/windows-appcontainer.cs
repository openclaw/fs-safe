// Real lowbox process fixture. No capabilities: access comes only from the two
// explicitly named profiles on the shared fixture root.
using System;
using System.ComponentModel;
using System.Collections.Generic;
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
  [StructLayout(LayoutKind.Sequential)] struct Trustee { public IntPtr Multiple; public int Operation, Form, Type; public IntPtr Name; }
  [StructLayout(LayoutKind.Sequential)] struct ExplicitAccess { public uint Permissions, Mode, Inheritance; public Trustee Trustee; }
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
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out uint value,uint size,out uint returned);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetLongPathNameW(string path,StringBuilder result,uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetShortPathNameW(string path,StringBuilder result,uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle,StringBuilder path,uint size,uint flags);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string path,int kind,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetEntriesInAclW(uint count,[In] ExplicitAccess[] entries,IntPtr old,out IntPtr acl);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfoW(string path,int kind,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string text) { return "\""+text+"\""; }
  static string Json(string text) { return "\""+text.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n").Replace("\t","\\t")+"\""; }
  static string Failure(int error) { return "\"ok\":false,\"win32Error\":"+error+",\"message\":"+Json(new Win32Exception(error).Message); }
  // This executable runs in the same fresh AppContainer as the Node diagnostic,
  // separating handle-open failures from normalized volume-name query failures.
  public static int Main(string[] args) {
    if(args.Length!=2) throw new ArgumentException("Expected paths and receipt filenames");
    IntPtr token; Check(OpenProcessToken(GetCurrentProcess(),8,out token));
    uint contained,returned;
    try { Check(GetTokenInformation(token,29,out contained,4,out returned)); }
    finally { CloseHandle(token); }
    if(contained!=1) throw new Exception("Native diagnostic is not in an AppContainer");
    var rows=new List<string>();
    foreach(string line in File.ReadAllLines(args[0])) {
      var pair=line.Split(new[]{'\t'},2);
      foreach(uint access in new uint[]{0,0x80}) {
        string prefix="\"label\":"+Json(pair[0])+",\"path\":"+Json(pair[1])+",\"access\":"+access;
        IntPtr handle=CreateFileW(pair[1],access,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
        if(handle==new IntPtr(-1)) {
          int error=Marshal.GetLastWin32Error();
          rows.Add("{"+prefix+",\"syscall\":\"CreateFileW\","+Failure(error)+"}"); continue;
        }
        rows.Add("{"+prefix+",\"syscall\":\"CreateFileW\",\"ok\":true}");
        try {
          foreach(uint flags in new uint[]{0,1,2}) {
            string volume=flags==0 ? "DOS" : flags==1 ? "GUID" : "NT";
            var result=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandleW(handle,result,(uint)result.Capacity,flags);
            int error=length==0 ? Marshal.GetLastWin32Error() : 0;
            string value=length==0 ? Failure(error) : "\"ok\":"+(length<result.Capacity ? "true" : "false")+",\"length\":"+length+",\"result\":"+Json(result.ToString());
            rows.Add("{"+prefix+",\"syscall\":\"GetFinalPathNameByHandleW\",\"volume\":"+Json(volume)+","+value+"}");
          }
        } finally { CloseHandle(handle); }
      }
    }
    File.WriteAllText(args[1],"{\"appContainer\":true,\"pointerSize\":"+IntPtr.Size+",\"rows\":["+String.Join(",",rows.ToArray())+"]}");
    return 0;
  }
  static string PathSpelling(string path,bool shortName) {
    var result=new StringBuilder(32768);
    uint length=shortName ? GetShortPathNameW(path,result,(uint)result.Capacity) : GetLongPathNameW(path,result,(uint)result.Capacity);
    Check(length!=0);
    if(length>=result.Capacity) throw new Exception("Path spelling exceeded diagnostic buffer");
    return result.ToString();
  }
  static byte[] AclBytes(IntPtr acl) {
    if(acl==IntPtr.Zero) throw new Exception("DACL is absent");
    var bytes=new byte[(ushort)Marshal.ReadInt16(acl,2)]; Marshal.Copy(acl,bytes,0,bytes.Length); return bytes;
  }
  // This is the pre-change native constructor, kept separate from the helper's
  // RawAcl baseline: SetEntriesInAclW owns native ACE ordering and encoding.
  static byte[] OriginalNativeAcl(string user,bool inherit) {
    var pins=new GCHandle[3]; IntPtr acl=IntPtr.Zero;
    try {
      var sids=new[]{user,"S-1-5-18","S-1-5-32-544"};
      var entries=new ExplicitAccess[3];
      for(int i=0;i<sids.Length;i++) {
        var sid=new SecurityIdentifier(sids[i]); var bytes=new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes,0);
        pins[i]=GCHandle.Alloc(bytes,GCHandleType.Pinned);
        entries[i]=new ExplicitAccess{Permissions=0x1f01ff,Mode=1,Inheritance=inherit ? 3u : 0u,
          Trustee=new Trustee{Form=0,Type=0,Name=pins[i].AddrOfPinnedObject()}};
      }
      uint error=SetEntriesInAclW(3,entries,IntPtr.Zero,out acl);
      if(error!=0) throw new Win32Exception((int)error);
      return AclBytes(acl);
    } finally { if(acl!=IntPtr.Zero) LocalFree(acl); foreach(var pin in pins) if(pin.IsAllocated) pin.Free(); }
  }
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
        IntPtr owner,group,dacl,sacl,descriptor;
        uint error=GetNamedSecurityInfoW(path,1,5,out owner,out group,out dacl,out sacl,out descriptor);
        if(error!=0) throw new Win32Exception((int)error);
        byte[] left;
        try { left=AclBytes(dacl); } finally { if(descriptor!=IntPtr.Zero) LocalFree(descriptor); }
        var right=new byte[expected.DiscretionaryAcl.BinaryLength]; expected.DiscretionaryAcl.GetBinaryForm(right,0);
        if(mode=="require") right=OriginalNativeAcl(user,directory);
        if(Convert.ToBase64String(left)!=Convert.ToBase64String(right) || !actual.Owner.Equals(expected.Owner) ||
          (actual.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) throw new Exception("Ordinary private DACL bytes changed ("+mode+", directory="+directory+"): actual="+Convert.ToBase64String(left)+" expected="+Convert.ToBase64String(right));
      }
    }
  }
  public static void Run(string root,bool diagnosticsOnly) {
    // Only fixture setup is elevated; CreateProcessW below creates restricted
    // AppContainer children. Refuse clearly before modifying any ancestor ACL.
    using(var identity=WindowsIdentity.GetCurrent()) {
      if(!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
        throw new InvalidOperationException("AppContainer fixture setup requires an elevated Windows runner to grant and restore ancestor metadata access");
    }
    string a="fs-safe-a-"+Guid.NewGuid().ToString("N"), b="fs-safe-b-"+Guid.NewGuid().ToString("N");
    IntPtr sidA=IntPtr.Zero,sidB=IntPtr.Zero;
    var ancestors=new Dictionary<string,byte[]>();
    try {
      Marshal.ThrowExceptionForHR(CreateAppContainerProfile(a,a,a,IntPtr.Zero,0,out sidA));
      Marshal.ThrowExceptionForHR(CreateAppContainerProfile(b,b,b,IntPtr.Zero,0,out sidB));
      // Node realpath lstats every ancestor, including the volume root. These
      // non-inheriting grants admit metadata/traversal, never descendant data.
      for(var ancestor=Directory.GetParent(root);ancestor!=null;ancestor=ancestor.Parent) {
        var original=Directory.GetAccessControl(ancestor.FullName,AccessControlSections.Access);
        ancestors.Add(ancestor.FullName,original.GetSecurityDescriptorBinaryForm());
        foreach(var sid in new[]{sidA,sidB}) original.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),
          FileSystemRights.ReadAttributes|FileSystemRights.Traverse,InheritanceFlags.None,PropagationFlags.None,AccessControlType.Allow));
        Directory.SetAccessControl(ancestor.FullName,original);
      }
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
      IntPtr profile;
      Marshal.ThrowExceptionForHR(GetAppContainerFolderPath(new SecurityIdentifier(sidA).Value,out profile));
      string profilePath;
      try { profilePath=Marshal.PtrToStringUni(profile); } finally { Marshal.FreeCoTaskMem(profile); }
      File.WriteAllLines(Path.Combine(root,"canonicalization-paths.txt"),new[]{
        "shared\t"+root,"profile\t"+profilePath,
        "shared-long\t"+PathSpelling(root,false),"shared-short\t"+PathSpelling(root,true),
        "drive-root\t"+Path.GetPathRoot(root)});
      Launch(root,sidA,"diagnostic-node","",true);
      Launch(root,sidA,"diagnostic-native","",true);
      if(diagnosticsOnly) return;
      Launch(root,sidA,"create","require");
      Launch(root,sidA,"reopen","require");
      Launch(root,sidB,"deny","require");
      Launch(root,sidA,"native-off","off");
    } finally {
      var failures=new List<Exception>();
      foreach(var ancestor in ancestors) try {
        var original=new DirectorySecurity(); original.SetSecurityDescriptorBinaryForm(ancestor.Value,AccessControlSections.Access);
        Directory.SetAccessControl(ancestor.Key,original);
      } catch(Exception error) { failures.Add(error); }
      if(sidA!=IntPtr.Zero) { FreeSid(sidA); try { Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(a)); } catch(Exception error) { failures.Add(error); } }
      if(sidB!=IntPtr.Zero) { FreeSid(sidB); try { Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(b)); } catch(Exception error) { failures.Add(error); } }
      if(failures.Count!=0) throw new AggregateException("AppContainer fixture cleanup failed",failures);
    }
  }
  static void Launch(string root,IntPtr sid,string operation,string mode,bool diagnostic=false) {
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
      string arguments=Quote(Path.Combine(root,"child.mjs"))+" "+operation+" "+mode;
      if(diagnostic) {
        arguments=Quote(Path.Combine(root,"canonicalization-paths.txt"))+" "+Quote(Path.Combine(root,operation+".json"));
        if(operation=="diagnostic-node") arguments=Quote(Path.Combine(root,"canonicalization.mjs"))+" "+arguments;
        else exe=Path.Combine(root,"canonicalization.exe");
      }
      var command=new StringBuilder(Quote(exe)+" "+arguments);
      Check(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x80000,IntPtr.Zero,root,ref startup,out process));
      uint wait=WaitForSingleObject(process.Process,60000);
      if(wait!=0) { TerminateProcess(process.Process,1); throw new Exception("AppContainer "+operation+"/"+mode+" child did not finish: "+wait); }
      uint code; Check(GetExitCodeProcess(process.Process,out code));
      string receipt=Path.Combine(root,operation+(diagnostic ? "" : "-"+mode)+".json");
      if(code!=0) throw new Exception("AppContainer "+operation+"/"+mode+" exit "+code+": "+(File.Exists(receipt) ? File.ReadAllText(receipt) : "child failed before writing its receipt"));
    } finally {
      if(process.Thread!=IntPtr.Zero) CloseHandle(process.Thread);
      if(process.Process!=IntPtr.Zero) CloseHandle(process.Process);
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(caps!=IntPtr.Zero) Marshal.FreeHGlobal(caps);
    }
  }
}
