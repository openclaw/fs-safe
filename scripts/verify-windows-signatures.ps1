param(
  [Parameter(Mandatory = $true)][string]$Directory,
  [switch]$Record
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$expectedSubject = 'CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US'
$files = @('fs-safe-native.win32-x64-msvc.node', 'fs-safe-native.win32-arm64-msvc.node', 'windows-security-helper.exe')
$manifestPath = Join-Path $Directory 'windows-signing.json'
if ($Record) {
  $unsigned = Get-Content -Raw (Join-Path $Directory 'unsigned-windows-sha256.json') | ConvertFrom-Json -AsHashtable
  $manifest = @{ version = 1; files = @{} }
} else {
  $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json -AsHashtable
  if ($manifest.version -ne 1) { throw 'Unsupported Windows signing manifest' }
}
foreach ($file in $files) {
  $path = Join-Path $Directory $file
  # .node is a PE DLL; WinVerifyTrust inspects it without loading either architecture.
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne 'Valid') { throw "$file Authenticode status is $($signature.Status); release stopped" }
  if ($null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cne $expectedSubject) {
    throw "$file must be signed by $expectedSubject"
  }
  if ($null -eq $signature.TimeStamperCertificate) { throw "$file must have an Authenticode timestamp" }
  if ($signature.SignatureType -ne 'Authenticode') { throw "$file must have an embedded Authenticode signature" }
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Record) {
    if ($unsigned[$file] -cnotmatch '^[a-f0-9]{64}$' -or $hash -ceq $unsigned[$file]) {
      throw "$file lacks a distinct pre-signing build SHA-256"
    }
    $manifest.files[$file] = @{
      unsignedSha256 = $unsigned[$file]
      signedSha256 = $hash
      status = 'Valid'
      subject = $signature.SignerCertificate.Subject
      timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
    }
  } elseif ($hash -cne $manifest.files[$file].signedSha256) {
    throw "$file differs from the verified signing output"
  }
  Write-Host "$file`: Valid, timestamped, SHA-256 $hash"
}
if ($Record) {
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
}
