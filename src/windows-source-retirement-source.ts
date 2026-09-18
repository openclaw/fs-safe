import { WINDOWS_MOVE_SOURCE } from "./windows-move-source.js";

export const WINDOWS_SOURCE_RETIREMENT_SOURCE = WINDOWS_MOVE_SOURCE + String.raw`
public static partial class FsSafeWindowsBridge {
  static FileInfo InspectRetirementFile(SafeFileHandle handle,string expected,uint links) {
    for(int attempt=0;attempt<2;attempt++) {
      var info=MoveInformation(handle); string observed=MoveIdentity(info);
      if(info.Volume!=0) Require(observed.Substring(0,8)==expected.Substring(0,8),"path-mismatch","retirement volume identity changed");
      if(info.IndexHigh!=0 || info.IndexLow!=0) Require(observed.Substring(9)==expected.Substring(9),"path-mismatch","retirement file identity changed");
      if(info.Volume==0 || (info.IndexHigh==0 && info.IndexLow==0)) continue;
      Require((info.Attributes&0x400)==0,"path-mismatch","retirement source became a reparse point");
      Require((info.Attributes&0x10)==0 && GetFileType(handle)==1,"path-mismatch","retirement source is not a regular file");
      Require(info.Links==links,"path-mismatch","retirement link count changed");
      return info;
    }
    throw new Failure("path-mismatch","retirement identity remained unknown");
  }
  static SafeFileHandle OpenRetirementSource(SafeFileHandle parent,string name) {
    return OpenMoveRelative(parent,name,0x00110080,false);
  }
  static void AssertRetirementParent(List<SafeFileHandle> handles,SafeFileHandle parent,string path,string expected) {
    InspectMoveHandle(parent,expected,true);
    var named=OpenMovePath(path,0x80); handles.Add(named); InspectMoveHandle(named,expected,true);
  }
  static bool SetSourceDisposition(SafeFileHandle source,ref uint flags) {
    return SetFileInformationByHandle(source,21,ref flags,4);
  }
  public static object ExecuteRetirement(string parentPath,string parentId,string sourceName,string sourceId,uint expectedLinks) {
    string phase="admission",commit="not-attempted",code=null,message=null,cleanupError=null,cleanupCode=null;
    uint? windowsError=null,remainingLinks=null;
    bool? readOnlyBefore=null,readOnlyAfter=null;
    var handles=new List<SafeFileHandle>();
    try {
      ValidateMoveIdentity(parentId); ValidateMoveIdentity(sourceId);
      Require(!String.IsNullOrEmpty(parentPath) && parentPath.IndexOf('\0')<0,"invalid-path","invalid retirement parent path");
      sourceName=MoveRelative(sourceName,false);
      Require(sourceName.IndexOf('\\')<0 && expectedLinks>=2,"invalid-path","retirement requires one child and a surviving published link");
      var parent=OpenMovePath(parentPath,0x80); handles.Add(parent); InspectMoveHandle(parent,parentId,true);
      // Open through the source NAME. A caller's retained fd may name target.
      var source=OpenRetirementSource(parent,sourceName); handles.Add(source);
      var before=InspectRetirementFile(source,sourceId,expectedLinks);
      readOnlyBefore=(before.Attributes&1)!=0;
      // A separate file object observes the inode after the deleting handle
      // closes. DuplicateHandle would keep the same delete file object alive.
      var observer=OpenMoveRelative(parent,sourceName,0x80,false); handles.Add(observer);
      InspectRetirementFile(observer,sourceId,expectedLinks);
      AssertRetirementParent(handles,parent,parentPath,parentId);
      var current=InspectRetirementFile(source,sourceId,expectedLinks);
      Require((current.Attributes&1)==(before.Attributes&1),"path-mismatch","retirement read-only state changed before dispatch");
      uint flags=3u | (readOnlyBefore.Value ? 16u : 0u);
      phase="delete"; commit="unknown";
      if(!SetSourceDisposition(source,ref flags)) {
        windowsError=(uint)Marshal.GetLastWin32Error();
        throw MoveOsFailure(windowsError.Value,"retire source link",true);
      }
      // POSIX disposition removes this link when its deleting handle closes,
      // even while the caller and observer retain their independent handles.
      phase="close-delete"; handles.Remove(source); CloseMoveHandle(source);
      commit="committed"; phase="verification";
      var after=InspectRetirementFile(observer,sourceId,expectedLinks-1);
      remainingLinks=after.Links; readOnlyAfter=(after.Attributes&1)!=0;
      Require(readOnlyAfter==readOnlyBefore,"path-mismatch","source retirement changed the read-only attribute");
      AssertRetirementParent(handles,parent,parentPath,parentId);
      phase="complete";
    } catch(Failure error) { code=error.Code; message=error.Message; }
      catch(Exception) { code="EIO"; message="Windows source retirement processing failed"; }
    for(int index=handles.Count-1;index>=0;index--) {
      try { CloseMoveHandle(handles[index]); }
      catch(Failure error) { if(cleanupCode==null) cleanupCode=error.Code; cleanupError=cleanupError==null ? error.Message : cleanupError+"; "+error.Message; }
      catch(Exception) { if(cleanupCode==null) cleanupCode="EIO"; cleanupError=cleanupError==null ? "retirement handle close failed" : cleanupError+"; retirement handle close failed"; }
    }
    if(cleanupError!=null && code==null) { code=cleanupCode; message=cleanupError; phase="close"; }
    return Row("ok",code==null,"phase",phase,"commit",commit,"sourceIdentity",sourceId,"expectedLinks",expectedLinks,
      "remainingLinks",remainingLinks,"readOnlyBefore",readOnlyBefore,"readOnlyAfter",readOnlyAfter,
      "windowsError",windowsError,"code",code,"message",message,"cleanupError",cleanupError);
  }
}
`;
