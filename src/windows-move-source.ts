import { WINDOWS_SECURITY_SOURCE } from "./windows-security-source.js";

// Reuse the built-in OS handle declarations without exporting CRT descriptors.
export const WINDOWS_MOVE_SOURCE = WINDOWS_SECURITY_SOURCE.replace(
  "public static class FsSafeWindowsBridge {",
  "public static partial class FsSafeWindowsBridge {",
) + String.raw`
public static partial class FsSafeWindowsBridge {
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatus io, IntPtr information, uint length, int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess, out SafeFileHandle target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

  static Failure MoveOsFailure(uint error,string operation,bool rename=false) {
    string code=error==80 || error==183 ? "EEXIST" : error==2 || error==3 ? "ENOENT" :
      error==39 || error==112 ? "ENOSPC" : error==32 || error==33 ? "EBUSY" : error==5 ? "EPERM" : "EIO";
    if(rename) {
      if(error==1 || error==50 || error==120) code="ENOTSUP";
      else if(error==87) code="EINVAL";
    }
    return new Failure(code,operation+" failed with Windows error "+error);
  }
  static SafeFileHandle OpenMovePath(string path,uint access) {
    var handle=CreateFileW(path,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(handle.IsInvalid) {
      uint error=(uint)Marshal.GetLastWin32Error(); handle.Dispose(); throw MoveOsFailure(error,"open move path");
    }
    return handle;
  }
  static FileInfo MoveInformation(SafeFileHandle handle) {
    FileInfo info;
    if(!GetFileInformationByHandle(handle,out info)) throw MoveOsFailure((uint)Marshal.GetLastWin32Error(),"inspect move identity");
    return info;
  }

  static void CloseMoveHandle(SafeFileHandle handle) {
    bool closed=CloseHandle(handle.DangerousGetHandle());
    uint error=(uint)Marshal.GetLastWin32Error();
    // Consume once even on failure; process exit owns any unreleased resource.
    handle.SetHandleAsInvalid(); handle.Dispose();
    if(!closed) throw MoveOsFailure(error,"close move handle");
  }

  static string MoveIdentity(FileInfo info) {
    return info.Volume.ToString("x8")+":"+(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString("x16");
  }
  static void ValidateMoveIdentity(string identity) {
    Require(identity!=null && System.Text.RegularExpressions.Regex.IsMatch(identity,@"^[0-9a-f]{8}:[0-9a-f]{16}$") &&
      identity.Substring(0,8)!="00000000" && identity.Substring(9)!="0000000000000000",
      "path-mismatch","move requires an exact known identity");
  }
  static FileInfo InspectMoveHandle(SafeFileHandle handle,string expected,bool directory,uint expectedLinks=1) {
    for(int attempt=0;attempt<2;attempt++) {
      FileInfo info=MoveInformation(handle);
      string observed=MoveIdentity(info);
      if(info.Volume!=0) Require(observed.Substring(0,8)==expected.Substring(0,8),"path-mismatch","move volume identity changed");
      if(info.IndexHigh!=0 || info.IndexLow!=0) Require(observed.Substring(9)==expected.Substring(9),"path-mismatch","move file identity changed");
      if(info.Volume==0 || (info.IndexHigh==0 && info.IndexLow==0)) continue;
      Require((info.Attributes&0x400)==0,"symlink","move must not follow a reparse point");
      if(directory) Require((info.Attributes&0x10)!=0,"path-mismatch","move parent is no longer a directory");
      else {
        Require((info.Attributes&0x10)==0,"invalid-path","directory moves require overwrite");
        Require(GetFileType(handle)==1,"not-file","move source must be a regular file");
        Require(info.Links==expectedLinks,"hardlink","move source link count changed");
      }
      return info;
    }
    throw new Failure("path-mismatch","move identity remained unknown");
  }
  static string MoveRelative(string value,bool allowEmpty) {
    Require(value!=null && value.IndexOf('\0')<0 && value.IndexOf(':')<0,"invalid-path","invalid move-relative path");
    value=value.Replace('/','\\');
    if(value.Length==0 && allowEmpty) return value;
    foreach(string component in value.Split('\\')) {
      Require(component.Length>0 && component!="." && component!=".." && !component.EndsWith(".") && !component.EndsWith(" "),
        "invalid-path","invalid move-relative component");
    }
    return value;
  }
  static SafeFileHandle OpenMoveRelative(SafeFileHandle parent,string name,uint access,bool directory) {
    if(name.Length==0) {
      SafeFileHandle duplicate;
      if(!DuplicateHandle(GetCurrentProcess(),parent,GetCurrentProcess(),out duplicate,0,false,2)) {
        uint error=(uint)Marshal.GetLastWin32Error(); if(duplicate!=null) duplicate.Dispose();
        throw MoveOsFailure(error,"retain move parent");
      }
      return duplicate;
    }
    IntPtr nameBuffer=Marshal.StringToHGlobalUni(name), unicodeBuffer=IntPtr.Zero;
    try {
      int bytes=checked(name.Length*2);
      Require(bytes<=65532,"invalid-path","move-relative path exceeds the NT name limit");
      var unicode=new UnicodeString { Length=(ushort)bytes,MaximumLength=(ushort)(bytes+2),Buffer=nameBuffer };
      unicodeBuffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))); Marshal.StructureToPtr(unicode,unicodeBuffer,false);
      var attributes=new ObjectAttributes { Length=(uint)Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=parent.DangerousGetHandle(),
        ObjectName=unicodeBuffer,Attributes=0x1040 };
      IoStatus io; SafeFileHandle opened;
      int status=NtCreateFile(out opened,access|0x00100080,ref attributes,out io,IntPtr.Zero,0,7,1,0x00200020u|(directory?1u:0u),IntPtr.Zero,0);
      if(status<0) { if(opened!=null) opened.Dispose(); throw MoveOsFailure(RtlNtStatusToDosError(status),"open move entry"); }
      return opened;
    } finally { if(unicodeBuffer!=IntPtr.Zero) Marshal.FreeHGlobal(unicodeBuffer); Marshal.FreeHGlobal(nameBuffer); }
  }
  static void InspectMoveParents(List<SafeFileHandle> handles,SafeFileHandle root,string rootPath,string rootId,
    SafeFileHandle sourceParent,string sourcePath,string sourceId,SafeFileHandle targetParent,string targetPath,string targetId) {
    if(root!=null) InspectMoveHandle(root,rootId,true);
    InspectMoveHandle(sourceParent,sourceId,true);
    InspectMoveHandle(targetParent,targetId,true);
    if(root!=null) { var namedRoot=OpenMovePath(rootPath,0x80); handles.Add(namedRoot); InspectMoveHandle(namedRoot,rootId,true); }
    var namedSource=OpenMovePath(sourcePath,0x80); handles.Add(namedSource); InspectMoveHandle(namedSource,sourceId,true);
    var namedTarget=OpenMovePath(targetPath,0x80); handles.Add(namedTarget); InspectMoveHandle(namedTarget,targetId,true);
  }
  static int RenameMoveHandle(SafeFileHandle source,SafeFileHandle targetParent,string targetName) {
    Require(IntPtr.Size==8,"ENOTSUP","atomic move requires the Windows 64-bit rename ABI");
    int nameBytes=checked(targetName.Length*2), length=Math.Max(24,checked(20+nameBytes));
    IntPtr buffer=Marshal.AllocHGlobal(length);
    try {
      Marshal.Copy(new byte[length],0,buffer,length);
      Marshal.WriteInt32(buffer,0,2); // POSIX semantics; never REPLACE_IF_EXISTS.
      Marshal.WriteIntPtr(buffer,8,targetParent.DangerousGetHandle());
      Marshal.WriteInt32(buffer,16,nameBytes);
      Marshal.Copy(targetName.ToCharArray(),0,IntPtr.Add(buffer,20),targetName.Length);
      IoStatus io;
      return NtSetInformationFile(source,out io,buffer,(uint)length,65);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static object ExecuteMove(string rootPath,string rootId,string sourceParentPath,string sourceRelative,string sourceParentId,
    string sourceName,string sourceId,string targetParentPath,string targetRelative,string targetParentId,string targetName) {
    return ExecuteMoveCore(rootPath,rootId,sourceParentPath,sourceRelative,sourceParentId,sourceName,sourceId,1,
      targetParentPath,targetRelative,targetParentId,targetName,true);
  }
  public static object ExecuteFileMove(string sourceParentPath,string sourceParentId,string sourceName,string sourceId,uint expectedLinks,
    string targetParentPath,string targetParentId,string targetName) {
    return ExecuteMoveCore(null,null,sourceParentPath,null,sourceParentId,sourceName,sourceId,expectedLinks,
      targetParentPath,null,targetParentId,targetName,false);
  }
  static object ExecuteMoveCore(string rootPath,string rootId,string sourceParentPath,string sourceRelative,string sourceParentId,
    string sourceName,string sourceId,uint expectedLinks,string targetParentPath,string targetRelative,string targetParentId,string targetName,bool rooted) {
    string phase="admission",commit="not-attempted",code=null,message=null,observedTarget=null;
    int? ntStatus=null;
    var handles=new List<SafeFileHandle>();
    try {
      if(rooted) { ValidateMoveIdentity(rootId); Require(!String.IsNullOrEmpty(rootPath) && rootPath.IndexOf('\0')<0,"invalid-path","invalid canonical move root"); }
      foreach(string id in new[]{sourceParentId,targetParentId,sourceId}) ValidateMoveIdentity(id);
      foreach(string value in new[]{sourceParentPath,targetParentPath}) Require(!String.IsNullOrEmpty(value) && value.IndexOf('\0')<0,"invalid-path","invalid canonical move path");
      Require(expectedLinks>0,"path-mismatch","move requires a positive link count");
      if(rooted) { sourceRelative=MoveRelative(sourceRelative,true); targetRelative=MoveRelative(targetRelative,true); }
      sourceName=MoveRelative(sourceName,false); targetName=MoveRelative(targetName,false);
      Require(sourceName.IndexOf('\\')<0 && targetName.IndexOf('\\')<0,"invalid-path","move names must be direct children");
      SafeFileHandle root=null;
      if(rooted) { root=OpenMovePath(rootPath,0x00120089); handles.Add(root); InspectMoveHandle(root,rootId,true); }
      var sourceParent=rooted ? OpenMoveRelative(root,sourceRelative,0x00120089,true) : OpenMovePath(sourceParentPath,0x00100080);
      handles.Add(sourceParent); InspectMoveHandle(sourceParent,sourceParentId,true);
      var targetParent=rooted ? OpenMoveRelative(root,targetRelative,0x00120089,true) : OpenMovePath(targetParentPath,0x00100080);
      handles.Add(targetParent); InspectMoveHandle(targetParent,targetParentId,true);
      var source=OpenMoveRelative(sourceParent,sourceName,0x00110080,false); handles.Add(source);
      uint attributes=InspectMoveHandle(source,sourceId,false,expectedLinks).Attributes;
      InspectMoveParents(handles,root,rootPath,rootId,sourceParent,sourceParentPath,sourceParentId,targetParent,targetParentPath,targetParentId);
      var namedSource=OpenMoveRelative(sourceParent,sourceName,0x80,false); handles.Add(namedSource); InspectMoveHandle(namedSource,sourceId,false,expectedLinks);
      InspectMoveHandle(source,sourceId,false,expectedLinks);
      phase="rename"; commit="unknown";
      ntStatus=RenameMoveHandle(source,targetParent,targetName);
      // Preserve the actual NT status. A target appearing later is never used
      // to relabel an arbitrary I/O error as a collision or trigger a retry.
      if(ntStatus.Value==unchecked((int)0xc0000035) || ntStatus.Value==unchecked((int)0xc0000101)) {
        commit="not-attempted"; throw new Failure("EEXIST","atomic no-replace destination exists");
      }
      if(ntStatus.Value<0) throw MoveOsFailure(RtlNtStatusToDosError(ntStatus.Value),"atomic no-replace move",true);
      commit="committed"; phase="verification";
      var after=InspectMoveHandle(source,sourceId,false,expectedLinks);
      Require((after.Attributes&1)==(attributes&1),"path-mismatch","move changed the read-only attribute");
      var namedTarget=OpenMoveRelative(targetParent,targetName,0x80,false); handles.Add(namedTarget);
      var target=InspectMoveHandle(namedTarget,sourceId,false,expectedLinks);
      Require((target.Attributes&1)==(attributes&1),"path-mismatch","move target read-only attribute changed");
      observedTarget=MoveIdentity(target);
      InspectMoveParents(handles,root,rootPath,rootId,sourceParent,sourceParentPath,sourceParentId,targetParent,targetParentPath,targetParentId);
      phase="complete";
    } catch(Failure error) { code=error.Code; message=error.Message; }
      catch(Exception) { code="EIO"; message="Windows atomic move processing failed"; }
    string cleanupError=null,cleanupCode=null;
    for(int index=handles.Count-1;index>=0;index--) {
      try { CloseMoveHandle(handles[index]); }
      catch(Failure error) { if(cleanupCode==null) cleanupCode=error.Code; cleanupError=cleanupError==null ? error.Message : cleanupError+"; "+error.Message; }
      catch(Exception) { if(cleanupCode==null) cleanupCode="EIO"; cleanupError=cleanupError==null ? "Windows move handle close failed" : cleanupError+"; Windows move handle close failed"; }
    }
    if(cleanupError!=null && code==null) { code=cleanupCode; message=cleanupError; phase="close"; }
    return Row("ok",code==null,"phase",phase,"commit",commit,"sourceIdentity",sourceId,"targetIdentity",observedTarget,
      "code",code,"message",message,"ntStatus",ntStatus,"cleanupError",cleanupError);
  }
}
`;
