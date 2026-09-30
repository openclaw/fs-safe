# Real unsupported-filesystem admission. Own one transient FAT VHD, never a host disk.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('fs-safe-publication-volume-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$image = Join-Path $fixture 'unsupported.vhd'
$letter = @('Z','Y','X','W','V','U','T','S','R') | Where-Object { -not (Test-Path ($_.ToString() + ':\')) } | Select-Object -First 1
if (-not $letter) { throw 'No unused drive letter for isolated filesystem proof' }
$label = 'FSP' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$setup = Join-Path $fixture 'setup.txt'
$teardown = Join-Path $fixture 'teardown.txt'
try {
  @"
create vdisk file="$image" maximum=32 type=expandable
select vdisk file="$image"
attach vdisk
create partition primary
format fs=fat quick label=$label
assign letter=$letter
"@ | Set-Content -Path $setup -Encoding ascii
  & diskpart.exe /s $setup | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Owned FAT fixture setup failed' }
  $volume = Get-Volume -DriveLetter $letter
  if ($volume.FileSystemLabel -ne $label -or $volume.FileSystem -ne 'FAT') { throw 'Owned FAT volume identity not established' }
  & node scripts/windows-publication-volume-probe.mjs ($letter + ':\')
  if ($LASTEXITCODE -ne 0) { throw 'Unsupported-filesystem publication proof failed' }
} finally {
  if (Test-Path $image) {
    @"
select vdisk file="$image"
detach vdisk
"@ | Set-Content -Path $teardown -Encoding ascii
    & diskpart.exe /s $teardown | Out-Host
    if ((Get-DiskImage -ImagePath $image).Attached) { throw 'Owned VHD remains attached; refusing fixture deletion' }
  }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
