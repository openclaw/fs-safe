// Frozen pre-helper query: independent Windows compatibility oracle.
export function encodePowerShellCommand(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

export function windowsOwnerQueryCommand(targetPath: string): string {
  const encodedPath = Buffer.from(targetPath, "utf8").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner",
    "$acl=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p,$sections)}else{[IO.File]::GetAccessControl($p,$sections)}",
    "$ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$root=[IO.Path]::GetPathRoot($p)",
    "$extendedDrive=$p.Length -ge 7 -and $p.StartsWith('\\\\?\\') -and [char]::IsLetter($p[4]) -and $p[5] -eq ':' -and $p[6] -eq '\\'",
    "$driveRoot=if($extendedDrive){$p.Substring(4,3)}else{$root}",
    "$namespacePath=$p.StartsWith('\\\\')",
    "$remote=($namespacePath -and -not $extendedDrive) -or ([IO.DriveInfo]::new($driveRoot).DriveType -eq [IO.DriveType]::Network)",
    // Emit only ASCII SID and numeric facts: console encodings can replace both
    // Unicode pathnames and account names before JavaScript receives the bytes.
    "$raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)",
    "$dacl=$raw.DiscretionaryAcl;$complete=$true",
    "$aces=@(foreach($ace in $dacl){if($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback -or [int]$ace.AceType -notin @(0,1)){$complete=$false;continue};@{sid=$ace.SecurityIdentifier.Value;mask=([long]$ace.AccessMask -band 4294967295);deny=([int]$ace.AceType -eq 1);inheritOnly=([int]$ace.AceFlags -band 8) -ne 0}})",
    "@{ownerSid=$ownerSid;currentUserSid=$currentSid;daclPresent=($null -ne $dacl);aces=$aces;complete=$complete;remote=$remote}|Microsoft.PowerShell.Utility\\ConvertTo-Json -Depth 4 -Compress",
  ].join(";");
}
