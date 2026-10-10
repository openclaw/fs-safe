param([switch]$Cleanup, [switch]$DevDrive)
$ErrorActionPreference = 'Stop'
$image = Join-Path $env:RUNNER_TEMP 'fs-safe-refs.vhdx'
$commands = Join-Path $env:RUNNER_TEMP 'fs-safe-refs-diskpart.txt'
if ($Cleanup) {
  if (Test-Path $image) {
    @("select vdisk file=`"$image`"", 'detach vdisk') | Set-Content $commands
    & diskpart /s $commands
    if ($LASTEXITCODE -ne 0) { throw 'ReFS test volume detach failed' }
    Remove-Item $image
  }
  exit 0
}
$letter = @('R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z') |
  Where-Object { -not (Test-Path "${_}:\") } | Select-Object -First 1
if (-not $letter) { throw 'No free ReFS test drive letter' }
@("create vdisk file=`"$image`" maximum=2048 type=expandable", 'attach vdisk',
  'create partition primary', "assign letter=$letter") | Set-Content $commands
& diskpart /s $commands
if ($LASTEXITCODE -ne 0) { throw 'ReFS test volume creation failed' }
if ($DevDrive) {
  & format "${letter}:" /FS:ReFS /DevDrv /Q /Y /V:fs-safe-proof
  if ($LASTEXITCODE -ne 0) { throw 'Dev Drive formatting failed' }
} else {
  Format-Volume -DriveLetter $letter -FileSystem ReFS -NewFileSystemLabel 'fs-safe-proof' -Confirm:$false
}
$volume = Get-Volume -DriveLetter $letter
if ($volume.FileSystem -ne 'ReFS') { throw "Expected ReFS, got $($volume.FileSystem)" }
$testRoot = "${letter}:\proof"
New-Item -ItemType Directory -Path $testRoot | Out-Null
"FS_SAFE_CLONE_TEST_ROOT=$testRoot" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
$volume | Format-List DriveLetter, FileSystem, AllocationUnitSize, Size
