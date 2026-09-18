param([Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Target
$raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
$aces = @()
foreach ($ace in $raw.DiscretionaryAcl) {
  if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback) {
    throw 'Unexpected ACL entry in private creation proof'
  }
  $aces += @{ sid=$ace.SecurityIdentifier.Value.ToLowerInvariant(); mask=$ace.AccessMask;
    type=$ace.AceQualifier.ToString(); flags=[int]$ace.AceFlags }
}
@{ owner=$raw.Owner.Value.ToLowerInvariant();
  current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value.ToLowerInvariant();
  protected=([bool]($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected));
  present=($null -ne $raw.DiscretionaryAcl); aces=$aces } | Microsoft.PowerShell.Utility\ConvertTo-Json -Depth 4 -Compress
