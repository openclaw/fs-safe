param([Parameter(Mandatory=$true)][string]$EncodedTargets)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ($utf8.GetString([Convert]::FromBase64String($EncodedTargets)))
if ($request -isnot [PSCustomObject] -or $request.paths -isnot [Array] -or $request.paths.Count -lt 1 -or $request.paths.Count -gt 3) {
  throw 'Invalid creation ACL batch'
}
$targets = $request.paths
for ($index = 0; $index -lt $targets.Count; $index++) {
  $target = $targets[$index]
  if ($target -isnot [string] -or $target.Length -eq 0 -or $target.Contains([string][char]0) -or [Array]::IndexOf($targets, $target) -ne $index) {
    throw 'Invalid creation ACL target'
  }
}
# -File receives one scalar; paths are decoded as data and never evaluated.
$rows = @(for ($index = 0; $index -lt $targets.Count; $index++) {
  $target = $targets[$index]
  $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $target
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $aces = @()
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback) {
      throw 'Unexpected ACL entry in private creation proof'
    }
    $aces += @{ sid=$ace.SecurityIdentifier.Value.ToLowerInvariant(); mask=$ace.AccessMask;
      type=$ace.AceQualifier.ToString(); flags=[int]$ace.AceFlags }
  }
  @{ index=$index; pathBase64=[Convert]::ToBase64String($utf8.GetBytes($target));
    owner=$raw.Owner.Value.ToLowerInvariant();
    current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value.ToLowerInvariant();
    protected=([bool]($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected));
    present=($null -ne $raw.DiscretionaryAcl); aces=$aces }
})
# Buffer the complete batch so a later failed query emits no success prefix.
Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{ rows=$rows } -Depth 6 -Compress
