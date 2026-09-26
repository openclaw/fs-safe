// Executed only by the built-in Windows PowerShell/.NET host. The raw security
// descriptor never passes through CommonSecurityDescriptor's ACE normalization.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static partial class FsSafeWindowsBridge {
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    public uint Length; public IntPtr RootDirectory, ObjectName; public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileId {
    public ulong Volume; [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] Id;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int standard);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo information);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out FileId information, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref uint information, uint size);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle, int kind, uint sections, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorOwner(IntPtr descriptor, out IntPtr owner, out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle handle, int kind, uint sections, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle handle, out IoStatus io, [Out] byte[] information, uint length, int kind);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus io, IntPtr allocation, uint flags, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);

  sealed class Failure : Exception {
    public readonly string Code;
    public Failure(string code, string message) : base(message) { Code=code; }
  }
  static Failure OsFailure(uint error, string operation, bool identity=false, bool fullIdentity=false) {
    // Native security calls retain EACCES; shared handle identity calls use EPERM.
    string code=error==5 ? (identity ? "EPERM" : "EACCES") : error==80 || error==183 ? "EEXIST" : error==2 || error==3 ? "ENOENT" :
      identity && (error==112 || error==39) ? "ENOSPC" : identity && (error==32 || error==33) ? "EBUSY" :
      fullIdentity && (error==1 || error==50 || error==87) ? "ENOTSUP" : "EIO";
    return new Failure(code, operation+" failed with Windows error "+error);
  }
  static Failure CreateFailure(uint error) {
    var failure=OsFailure(error,"create private directory",true);
    return failure.Code=="EPERM" ? new Failure("EACCES",failure.Message) : failure;
  }
  static void Require(bool condition, string code, string message) {
    if (!condition) throw new Failure(code,message);
  }
  static Dictionary<string,object> Row(params object[] fields) {
    var result=new Dictionary<string,object>();
    for(int i=0;i<fields.Length;i+=2) result.Add((string)fields[i],fields[i+1]);
    return result;
  }
  static SafeFileHandle Open(string path, uint access, bool noFollow) {
    var handle=CreateFileW(path,access,7,IntPtr.Zero,3,0x02000000u | (noFollow ? 0x00200000u : 0),IntPtr.Zero);
    if(handle.IsInvalid) { uint error=(uint)Marshal.GetLastWin32Error(); handle.Dispose(); throw OsFailure(error,"open security handle"); }
    return handle;
  }
  static FileInfo Information(SafeFileHandle handle) {
    FileInfo info;
    if(!GetFileInformationByHandle(handle,out info)) throw OsFailure((uint)Marshal.GetLastWin32Error(),"inspect handle identity",true);
    return info;
  }
  static string Identity(SafeFileHandle handle) {
    var info=Information(handle);
    return info.Volume.ToString("x8")+":"+(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString("x16");
  }
  static string DirectoryIdentity(SafeFileHandle handle, bool requireLocal=false) {
    var info=Information(handle);
    Require((info.Attributes&0x400)==0,"ELOOP","private directory must not be a reparse point");
    Require((info.Attributes&0x10)!=0,"ENOTDIR","private directory handle must name a directory");
    if(requireLocal) Require(IsLocal(handle),"ENOTSUP","private directories require a local filesystem");
    return FullIdentity(handle);
  }
  static string FullIdentity(SafeFileHandle handle) {
    FileId id;
    if(!GetFileInformationByHandleEx(handle,18,out id,24)) throw OsFailure((uint)Marshal.GetLastWin32Error(),"inspect 128-bit file identity",true,true);
    Require(id.Id!=null && id.Id.Length==16,"EIO","file identity is incomplete");
    return id.Volume.ToString("x16")+":"+BitConverter.ToString(id.Id).Replace("-","").ToLowerInvariant();
  }
  static string FileIdentity(SafeFileHandle handle, uint expectedLinks) {
    var info=Information(handle);
    Require((info.Attributes&0x400)==0,"ELOOP","private file must not be a reparse point");
    Require((info.Attributes&0x10)==0 && GetFileType(handle)==1,"EINVAL","private file must be a regular disk file");
    Require(info.Links==expectedLinks,"EIO","private file link count changed");
    return FullIdentity(handle);
  }
  static string FinalPath(SafeFileHandle handle, uint flags) {
    int capacity=512;
    for(int attempt=0;attempt<4;attempt++) {
      var path=new StringBuilder(capacity);
      uint length=GetFinalPathNameByHandleW(handle,path,(uint)capacity,flags);
      if(length==0) throw OsFailure((uint)Marshal.GetLastWin32Error(),"inspect handle locality");
      if(length<capacity) return path.ToString();
      Require(length<32768,"EIO","final handle path exceeds the inspection budget");
      capacity=(int)length+1;
    }
    throw new Failure("EIO","final handle path changed during inspection");
  }
  static bool IsVolumeGuidPath(string path) {
    return path.Length>=49 && path.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase) &&
      path[47]=='}' && path[48]=='\\' &&
      System.Text.RegularExpressions.Regex.IsMatch(path.Substring(11,36),@"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
  }
  static bool IsLocalFinalPath(string path) {
    return !path.StartsWith(@"\\?\UNC\",StringComparison.Ordinal) &&
      (!path.StartsWith(@"\\",StringComparison.Ordinal) || path.StartsWith(@"\\?\",StringComparison.Ordinal));
  }
  static bool IsLocal(SafeFileHandle handle) {
    IoStatus io; var remote=new byte[]{255};
    int status=NtQueryInformationFile(handle,out io,remote,1,51);
    if(status==0 && io.Information.ToUInt64()==1 && remote[0]<=1) return remote[0]==0;
    try {
      if(IsVolumeGuidPath(FinalPath(handle,9))) return true;
    } catch(Failure) { }
    return IsLocalFinalPath(FinalPath(handle,0));
  }
  static string Sid(SecurityIdentifier sid) {
    Require(sid!=null,"EIO","security descriptor SID is missing");
    return sid.Value.ToLowerInvariant();
  }
  static Dictionary<string,object> Security(SafeFileHandle handle, bool requireLocality=true) {
    IntPtr owner,group,dacl,sacl,descriptor;
    uint error=GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out descriptor);
    if(error!=0) throw OsFailure(error,"read owner and DACL");
    try {
      Require(descriptor!=IntPtr.Zero && owner!=IntPtr.Zero,"EIO","security descriptor is incomplete");
      uint length=GetSecurityDescriptorLength(descriptor);
      Require(length>=20 && length<=1024*1024,"EIO","security descriptor exceeds the inspection budget");
      var bytes=new byte[length]; Marshal.Copy(descriptor,bytes,0,(int)length);
      var raw=new RawSecurityDescriptor(bytes,0);
      string ownerSid=Sid(raw.Owner), currentSid;
      using(var current=WindowsIdentity.GetCurrent()) currentSid=Sid(current.User);
      var aces=new List<object>(); var unsupported=new List<int>();
      if(raw.DiscretionaryAcl!=null) foreach(GenericAce ace in raw.DiscretionaryAcl) {
        var basic=ace as CommonAce;
        if(basic==null || basic.IsCallback || (ace.AceType!=AceType.AccessAllowed && ace.AceType!=AceType.AccessDenied)) {
          unsupported.Add((int)ace.AceType); continue;
        }
        byte flags=(byte)ace.AceFlags;
        aces.Add(Row("sid",Sid(basic.SecurityIdentifier),"mask",unchecked((uint)basic.AccessMask),
          "aceType",ace.AceType==AceType.AccessAllowed ? "allow" : "deny",
          "flags",Row("raw",flags,"objectInherit",(flags&1)!=0,"containerInherit",(flags&2)!=0,
            "noPropagateInherit",(flags&4)!=0,"inheritOnly",(flags&8)!=0,"inherited",(flags&16)!=0,
            "successfulAccess",(flags&64)!=0,"failedAccess",(flags&128)!=0)));
      }
      bool isLocal;
      try { isLocal=IsLocal(handle); }
      catch(Failure) { if(requireLocality) throw; isLocal=false; }
      return Row("ownerSid",ownerSid,"currentUserSid",currentSid,"daclPresent",raw.DiscretionaryAcl!=null,
        "daclProtected",(raw.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0,
        "isLocal",isLocal,"aceListComplete",unsupported.Count==0,"unsupportedAceTypes",unsupported.ToArray(),"aces",aces.ToArray());
    } finally { if(descriptor!=IntPtr.Zero) LocalFree(descriptor); }
  }
  static byte[] PrivateSecurity(bool inherit=true) {
    SecurityIdentifier current;
    using(var identity=WindowsIdentity.GetCurrent()) current=identity.User;
    var acl=new RawAcl(2,3);
    var principals=new[]{current,new SecurityIdentifier("S-1-5-18"),new SecurityIdentifier("S-1-5-32-544")};
    var flags=inherit ? AceFlags.ObjectInherit|AceFlags.ContainerInherit : AceFlags.None;
    foreach(var principal in principals) acl.InsertAce(acl.Count,new CommonAce(flags,AceQualifier.AccessAllowed,0x1f01ff,principal,false,null));
    var descriptor=new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent|ControlFlags.DiscretionaryAclProtected|ControlFlags.SelfRelative,current,null,null,acl);
    var bytes=new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes,0); return bytes;
  }
  static SafeFileHandle CreateRelative(SafeFileHandle parent,string name) {
    byte[] security=PrivateSecurity();
    var pin=GCHandle.Alloc(security,GCHandleType.Pinned);
    IntPtr nameBuffer=Marshal.StringToHGlobalUni(name), unicodeBuffer=IntPtr.Zero;
    try {
      int byteLength=checked(name.Length*2);
      Require(byteLength>0 && byteLength<=65532,"EINVAL","private directory name is invalid");
      var unicode=new UnicodeString { Length=(ushort)byteLength, MaximumLength=(ushort)(byteLength+2), Buffer=nameBuffer };
      unicodeBuffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))); Marshal.StructureToPtr(unicode,unicodeBuffer,false);
      var attributes=new ObjectAttributes { Length=(uint)Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=parent.DangerousGetHandle(),
        ObjectName=unicodeBuffer,Attributes=0x40|0x1000,SecurityDescriptor=pin.AddrOfPinnedObject() };
      IoStatus io; SafeFileHandle created;
      int status=NtCreateFile(out created,0x00130180,ref attributes,out io,IntPtr.Zero,0,7,2,0x00200021,IntPtr.Zero,0);
      if(status<0) { if(created!=null) created.Dispose(); throw CreateFailure(RtlNtStatusToDosError(status)); }
      return created;
    } finally { if(unicodeBuffer!=IntPtr.Zero) Marshal.FreeHGlobal(unicodeBuffer); Marshal.FreeHGlobal(nameBuffer); pin.Free(); }
  }
  static void RequirePrivate(Dictionary<string,object> facts, bool requireProtected=true, bool requirePrivateChildren=false, bool allowAdministratorsOwner=false) {
    string current=(string)facts["currentUserSid"], owner=(string)facts["ownerSid"];
    Require((bool)facts["isLocal"] && (bool)facts["daclPresent"] && (!requireProtected || (bool)facts["daclProtected"]) &&
      (bool)facts["aceListComplete"] && (owner==current || (allowAdministratorsOwner && owner=="s-1-5-32-544")),
      "EACCES","private object security was not enforced");
    foreach(Dictionary<string,object> ace in (object[])facts["aces"]) {
      var flags=(Dictionary<string,object>)ace["flags"];
      string sid=(string)ace["sid"];
      if((string)ace["aceType"]=="deny" || sid==current || sid=="s-1-5-18" || sid=="s-1-5-32-544") continue;
      if((bool)flags["inheritOnly"] && (!requirePrivateChildren || (!(bool)flags["objectInherit"] && !(bool)flags["containerInherit"]))) continue;
      uint mask=(uint)ace["mask"];
      Require((mask&0xd00d01dfu)==0,"EACCES","private object permits untrusted access");
    }
  }
  static void SplitParent(string path, out string parentPath, out string name) {
    // JavaScript has already admitted and resolved this spelling. Keep extended
    // Win32 paths out of .NET Framework's separate pathname normalization.
    int separator=path.LastIndexOf('\\');
    Require(separator>0 && separator<path.Length-1,"EINVAL","private object must name a child");
    parentPath=path.Substring(0,separator); name=path.Substring(separator+1);
    if(parentPath.EndsWith(":")) parentPath+="\\";
  }
  static string ExpectedIdentity(string variable, bool required=true) {
    string identity=Environment.GetEnvironmentVariable(variable) ?? "";
    Require((!required && identity.Length==0) || System.Text.RegularExpressions.Regex.IsMatch(identity,@"\A[0-9a-f]{16}:[0-9a-f]{32}\z"),
      "EINVAL","complete expected Windows identity is required");
    return identity;
  }
  static void CheckParent(SafeFileHandle parent, string path, string identity) {
    Require(DirectoryIdentity(parent,true)==identity,"EIO","retained private parent changed");
    using(var named=Open(path,0x80,true)) Require(DirectoryIdentity(named,true)==identity,"EIO","private parent pathname changed");
  }
  static object InspectDirectory(string path) {
    bool requirePrivate=Environment.GetEnvironmentVariable("FS_SAFE_WINDOWS_SECURITY_REQUIRE_PRIVATE")=="1";
    using(var handle=Open(path,requirePrivate ? 0x00020080u : 0x80u,true)) {
      string identity=DirectoryIdentity(handle,true);
      if(requirePrivate) RequirePrivate(Security(handle),true,true);
      return Row("identity",identity);
    }
  }
  static void ProtectFileSecurity(SafeFileHandle handle) {
    byte[] security=PrivateSecurity(false);
    var pin=GCHandle.Alloc(security,GCHandleType.Pinned);
    try {
      bool present,defaulted; IntPtr dacl,owner;
      if(!GetSecurityDescriptorDacl(pin.AddrOfPinnedObject(),out present,out dacl,out defaulted)) {
        throw OsFailure((uint)Marshal.GetLastWin32Error(),"inspect private file DACL");
      }
      Require(present && dacl!=IntPtr.Zero,"EIO","private file DACL is incomplete");
      if(!GetSecurityDescriptorOwner(pin.AddrOfPinnedObject(),out owner,out defaulted)) {
        throw OsFailure((uint)Marshal.GetLastWin32Error(),"inspect private file owner");
      }
      Require(owner!=IntPtr.Zero,"EIO","private file owner is incomplete");
      uint error=SetSecurityInfo(handle,1,0x80000005u,owner,IntPtr.Zero,dacl,IntPtr.Zero);
      if(error!=0) throw OsFailure(error,"protect private file owner and DACL");
    } finally { pin.Free(); }
  }
  static void CheckFileAssociation(SafeFileHandle held, string path, string identity, uint links, SafeFileHandle parent, string parentPath, string parentIdentity) {
    Require(FileIdentity(held,links)==identity,"EIO","retained private file changed");
    using(var named=Open(path,0x80,true)) Require(FileIdentity(named,links)==identity,"EIO","private file pathname changed");
    CheckParent(parent,parentPath,parentIdentity);
  }
  static object PrivateFile(string path, bool protect) {
    string expectedParent=ExpectedIdentity("FS_SAFE_WINDOWS_SECURITY_PARENT_IDENTITY");
    string expectedFile=protect ? "" : ExpectedIdentity("FS_SAFE_WINDOWS_SECURITY_FILE_IDENTITY");
    uint links=1;
    if(!protect) Require(uint.TryParse(Environment.GetEnvironmentVariable("FS_SAFE_WINDOWS_SECURITY_EXPECTED_LINKS"),
      System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out links) && links>0,
      "EINVAL","private file expected link count is invalid");
    string parentPath,name; SplitParent(path,out parentPath,out name);
    using(var held=new SafeFileHandle(GetStdHandle(-10),false)) {
      Require(!held.IsInvalid,"EBADF","inherited file handle is unavailable");
      string identity=FileIdentity(held,links);
      if(!protect) Require(identity==expectedFile,"EIO","private file identity changed");
      // Windows can use Administrators as the creating token's default owner.
      // The inherited ACL must already be private: later changes cannot revoke
      // an earlier reader handle.
      RequirePrivate(Security(held),requireProtected:!protect,allowAdministratorsOwner:protect);
      using(var parent=Open(parentPath,0x80,true)) {
        CheckFileAssociation(held,path,identity,links,parent,parentPath,expectedParent);
        if(protect) using(var writable=Open(path,0x000e0080,true)) {
          Require(FileIdentity(writable,links)==identity,"EIO","private file changed before owner and DACL protection");
          RequirePrivate(Security(writable),requireProtected:false,allowAdministratorsOwner:true);
          CheckParent(parent,parentPath,expectedParent);
          ProtectFileSecurity(writable);
          RequirePrivate(Security(writable));
        }
        RequirePrivate(Security(held));
        CheckFileAssociation(held,path,identity,links,parent,parentPath,expectedParent);
        return Row("identity",identity);
      }
    }
  }
  static object CreatePrivate(string path) {
    string parentPath,name; SplitParent(path,out parentPath,out name);
    string expectedParent=ExpectedIdentity("FS_SAFE_WINDOWS_SECURITY_PARENT_IDENTITY",false);
    using(var parent=Open(parentPath,0xa4,true)) {
      string parentId=DirectoryIdentity(parent,true);
      if(expectedParent.Length!=0) Require(parentId==expectedParent,"EIO","private parent changed before creation");
      using(var created=CreateRelative(parent,name)) {
        try {
          string createdId=DirectoryIdentity(created);
          RequirePrivate(Security(created));
          Require(DirectoryIdentity(parent)==parentId,"EIO","retained private parent changed");
          using(var namedParent=Open(parentPath,0x80,true)) Require(DirectoryIdentity(namedParent,true)==parentId,"EIO","private parent pathname changed");
          using(var named=Open(path,0x80,true)) {
            Require(DirectoryIdentity(named,true)==createdId,"EIO","private directory pathname changed");
          }
          return Row("created",true,"identity",createdId);
        } catch(Exception primary) {
          uint flags=0x13;
          if(!SetFileInformationByHandle(created,21,ref flags,4)) {
            var failure=primary as Failure;
            throw new Failure(failure==null ? "EIO" : failure.Code,
              (failure==null ? "private directory validation failed" : failure.Message)+
              "; owned-handle cleanup failed with Windows error "+Marshal.GetLastWin32Error());
          }
          throw;
        }
      }
    }
  }
  static object InspectPath(string path) {
    // Raw reporting retains ACL facts when locality is unknown; admission remains strict.
    using(var handle=Open(path,0x00020080,false)) return Security(handle,false);
  }
  public static object Execute(string operation,string path) {
    try {
      object result;
      if(operation=="create") result=CreatePrivate(path);
      else if(operation=="directory") result=InspectDirectory(path);
      else if(operation=="protect-file" || operation=="verify-file") result=PrivateFile(path,operation=="protect-file");
      else if(operation=="descriptor") {
        using(var handle=new SafeFileHandle(GetStdHandle(-10),false)) {
          Require(!handle.IsInvalid,"EBADF","inherited file handle is unavailable");
          result=Row("identity",Identity(handle),"security",Security(handle));
        }
      } else if(operation=="path") result=InspectPath(path);
      else throw new Failure("EINVAL","unknown Windows security operation");
      return Row("ok",true,"result",result);
    } catch(Failure error) { return Row("ok",false,"code",error.Code,"message",error.Message); }
      catch(Exception) { return Row("ok",false,"code","EIO","message","Windows security descriptor processing failed"); }
  }
}
