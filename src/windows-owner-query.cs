// Compatibility pathname query: retain .NET's named security and ACL normalization.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

public static class FsSafeWindowsOwnerQuery {
  public static object Execute(string path) {
    var sections=AccessControlSections.Access | AccessControlSections.Owner;
    FileSystemSecurity acl=Directory.Exists(path)
      ? (FileSystemSecurity)Directory.GetAccessControl(path,sections)
      : File.GetAccessControl(path,sections);
    string ownerSid=acl.GetOwner(typeof(SecurityIdentifier)).Value;
    string currentSid;
    using(var current=WindowsIdentity.GetCurrent()) currentSid=current.User.Value;
    string root=Path.GetPathRoot(path);
    bool extendedDrive=path.Length>=7 && path.StartsWith(@"\\?\") && char.IsLetter(path[4]) && path[5]==':' && path[6]=='\\';
    string driveRoot=extendedDrive ? path.Substring(4,3) : root;
    bool namespacePath=path.StartsWith(@"\\");
    bool remote=(namespacePath && !extendedDrive) || new DriveInfo(driveRoot).DriveType==DriveType.Network;
    var raw=new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(),0);
    var dacl=raw.DiscretionaryAcl;
    bool complete=true;
    var aces=new List<object>();
    if(dacl!=null) foreach(GenericAce ace in dacl) {
      var basic=ace as CommonAce;
      int type=(int)ace.AceType;
      if(basic==null || basic.IsCallback || (type!=0 && type!=1)) { complete=false; continue; }
      aces.Add(new Dictionary<string,object>{
        {"sid",basic.SecurityIdentifier.Value},{"mask",((long)basic.AccessMask)&0xffffffffL},
        {"deny",type==1},{"inheritOnly",((int)ace.AceFlags&8)!=0}
      });
    }
    return new Dictionary<string,object>{
      {"ownerSid",ownerSid},{"currentUserSid",currentSid},{"remote",remote},
      {"complete",complete},{"daclPresent",dacl!=null},{"aces",aces}
    };
  }
}
