$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('fs-safe-exact-ntfs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$image = Join-Path $fixture 'receipts.vhd'
$letter = @('Z','Y','X','W','V','U','T','S','R') | Where-Object { -not (Test-Path ($_.ToString() + ':\')) } | Select-Object -First 1
if (-not $letter) { throw 'No unused drive letter for isolated NTFS proof' }
$label = 'FSE' + [guid]::NewGuid().ToString('N').Substring(0, 8)
try {
  $setup = Join-Path $fixture 'setup.txt'
  @"
create vdisk file="$image" maximum=128 type=expandable
select vdisk file="$image"
attach vdisk
create partition primary
format fs=ntfs quick label=$label
assign letter=$letter
"@ | Set-Content -Path $setup -Encoding ascii
  & diskpart.exe /s $setup | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Owned NTFS fixture setup failed' }
  $volume = Get-Volume -DriveLetter $letter
  if ($volume.FileSystemLabel -ne $label -or $volume.FileSystem -ne 'NTFS') { throw 'Owned NTFS volume identity not established' }
  $volume | Select-Object DriveLetter, FileSystem, FileSystemLabel | Format-Table
  & node scripts/exact-receipts-proof.mjs ($letter + ':\')
  if ($LASTEXITCODE -ne 0) { throw 'Exact receipt NTFS proof failed' }
} finally {
  if (Test-Path $image) {
    $teardown = Join-Path $fixture 'teardown.txt'
    @"
select vdisk file="$image"
detach vdisk
"@ | Set-Content -Path $teardown -Encoding ascii
    & diskpart.exe /s $teardown | Out-Host
    if ((Get-DiskImage -ImagePath $image).Attached) { throw 'Owned VHD remains attached; refusing fixture deletion' }
  }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
