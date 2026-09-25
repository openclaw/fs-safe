param([switch]$CleanupOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$root = Join-Path $env:RUNNER_TEMP 'fs-safe-native-pair'
$output = Join-Path $root 'artifacts'
$image = Join-Path $root 'owned-refs.vhdx'
$ownershipFile = Join-Path $output 'owned-vhd.json'
$roles = [ordered]@{
    baseline = @{ commit='373588be29efc32921121af20470b5239cd8f1fa'; tree='b4a8a0046a0c52eaebfd0e2ba268d3382954f1d9' }
    candidate = @{ commit='a60bccbbd33e90d5e5224febdfcaaccc8f511598'; tree='0882c5571d37283f0448197099a64d5abc77ab8f' }
}
function Save-Json([string]$name, $value) {
    [IO.File]::WriteAllText((Join-Path $output $name), (ConvertTo-Json -InputObject $value -Depth 12), [Text.UTF8Encoding]::new($false))
}
function Hash([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
function Owned-BuildProcesses {
    $markers = @($root, (Join-Path $env:GITHUB_WORKSPACE 'baseline'), (Join-Path $env:GITHUB_WORKSPACE 'candidate'))
    @(Get-CimInstance Win32_Process | Where-Object {
        $process = $_
        $process.ProcessId -ne $PID -and @($markers | Where-Object {
            $prefix = $_.Replace('\','/').ToLowerInvariant()
            $executable = ([string]$process.ExecutablePath).Replace('\','/').ToLowerInvariant()
            $command = ([string]$process.CommandLine).Replace('\','/').ToLowerInvariant()
            $executable.StartsWith($prefix + '/') -or $command -match ([regex]::Escape($prefix) + '(?=[/"\s]|$)')
        }).Count -gt 0
    })
}
function Settle-OwnedBuildProcesses {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $owned = @(Owned-BuildProcesses)
    Save-Json 'processes-before-cleanup.json' @($owned | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath)
    foreach ($entry in $owned) {
        $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) { continue }
        try {
            if ($process.HasExited) { continue }
            $handle = $process.Handle
            if ($handle -eq [IntPtr]::Zero -or [Math]::Abs(($process.StartTime.ToUniversalTime() - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) { throw 'Owned process identity changed' }
            $process.Kill($true)
            $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0 -or !$process.WaitForExit($remaining)) { throw 'Owned process did not settle within cleanup cap' }
        } finally { $process.Dispose() }
    }
    $remainingProcesses = @(Owned-BuildProcesses)
    Save-Json 'processes-after-cleanup.json' @($remainingProcesses | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath)
    if ($remainingProcesses.Count) { throw 'Owned build processes remain; VHD cleanup is unresolved' }
}
function Cleanup-OwnedImage {
    if (!(Test-Path -LiteralPath $ownershipFile)) { return }
    $owner = Get-Content -LiteralPath $ownershipFile -Raw | ConvertFrom-Json
    if ($owner.runId -cne $env:GITHUB_RUN_ID -or $owner.attempt -cne $env:GITHUB_RUN_ATTEMPT -or $owner.image -cne $image) { throw 'VHD ownership receipt mismatch' }
    Settle-OwnedBuildProcesses
    if (Test-Path -LiteralPath $image) {
        if ($owner.mountAttempted) {
            $diskImage = Get-DiskImage -ImagePath $image
            if ($diskImage.Attached) {
                $disks = @($diskImage | Get-Disk)
                if ($disks.Count -ne 1 -or $disks[0].IsBoot -or $disks[0].IsSystem -or
                    $owner.previousDiskNumbers -contains $disks[0].Number -or $owner.previousDiskIds -contains $disks[0].UniqueId) { throw 'VHD association is not uniquely owned' }
                if ($null -ne $owner.diskNumber -and ($disks[0].Number -ne $owner.diskNumber -or $disks[0].UniqueId -cne $owner.diskUniqueId)) { throw 'VHD disk identity changed' }
                Dismount-DiskImage -ImagePath $image | Out-Null
            }
            if ((Get-DiskImage -ImagePath $image).Attached) { throw 'Owned VHD remains attached' }
        }
        Remove-Item -LiteralPath $image -Force
    }
    if (Test-Path -LiteralPath $image) { throw 'Owned VHD remains on disk' }
    Save-Json 'cleanup.json' ([ordered]@{ runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; image=$image; processesSettled=$true; attached=$false; deleted=$true })
}
if ($CleanupOnly) { Cleanup-OwnedImage; return }
if (Test-Path -LiteralPath $root) { throw 'Refuse an existing pair-build directory' }
New-Item -ItemType Directory -Path $output | Out-Null
$failure = $null
$cleanupFailure = $null
$steps = [Collections.Generic.List[object]]::new()
function Run-Step([string]$name, [scriptblock]$action) {
    $receipt = [ordered]@{ name=$name; exitCode=$null; startedAt=[DateTime]::UtcNow.ToString('o') }
    $global:LASTEXITCODE = 0
    try {
        & $action 1> (Join-Path $output "$name.stdout.log") 2> (Join-Path $output "$name.stderr.log")
        $receipt.exitCode = $LASTEXITCODE
        if ($receipt.exitCode -isnot [int] -or $receipt.exitCode -ne 0) { throw "$name exited $($receipt.exitCode)" }
    } finally {
        $receipt.completedAt = [DateTime]::UtcNow.ToString('o')
        $steps.Add($receipt)
        Save-Json 'steps.json' $steps.ToArray()
    }
}
function Source-Snapshot([string]$role, [string]$suffix) {
    $source = Join-Path $env:GITHUB_WORKSPACE $role
    $commit = (& git -C $source rev-parse HEAD).Trim()
    $tree = (& git -C $source rev-parse 'HEAD^{tree}').Trim()
    if ($commit -cne $roles[$role].commit -or $tree -cne $roles[$role].tree) { throw "$role source identity mismatch" }
    & git -C $source diff --quiet HEAD --
    if ($LASTEXITCODE -ne 0) { throw "$role tracked source changed" }
    $files = [ordered]@{}
    $paths = @(& git -C $source ls-files)
    if ($LASTEXITCODE -ne 0 -or !$paths.Count) { throw 'Cannot inventory source' }
    foreach ($relative in ($paths | Sort-Object)) { $files[$relative] = Hash (Join-Path $source $relative) }
    Save-Json "$role-source-$suffix.json" ([ordered]@{ commit=$commit; tree=$tree; files=$files })
    return $files
}
function Toolchain-Snapshot {
    $paths = [ordered]@{
        node=(Get-Command node.exe).Source; pnpm=(Get-Command pnpm.cmd).Source
        rustc=(& rustup which rustc).Trim(); cargo=(& rustup which cargo).Trim()
        compiler=(Get-Command cl.exe).Source; linker=(Get-Command link.exe).Source
        ucrt=(Join-Path $env:WindowsSdkDir "Lib\$($env:WindowsSDKVersion.TrimEnd('\'))\ucrt\x64\ucrt.lib")
        kernel32=(Join-Path $env:WindowsSdkDir "Lib\$($env:WindowsSDKVersion.TrimEnd('\'))\um\x64\kernel32.lib")
    }
    $files = [ordered]@{}
    foreach ($name in $paths.Keys) { $files[$name] = [ordered]@{ path=$paths[$name]; sha256=(Hash $paths[$name]) } }
    return [ordered]@{ rustc=(& rustc --version --verbose)-join "`n"; cargo=(& cargo --version).Trim(); node=(& node --version).Trim(); pnpm=(& pnpm.cmd --version).Trim(); msvc=$env:VCToolsVersion; windowsSdk=$env:WindowsSDKVersion; files=$files }
}
try {
    if (!$IsWindows -or [IntPtr]::Size -ne 8 -or (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors -ne 16) { throw 'Require native Windows x64 with exactly 16 CPUs' }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ReFS qualification requires an elevated runner' }
    foreach ($name in @('Get-Disk','Get-DiskImage','Mount-DiskImage','Dismount-DiskImage','Initialize-Disk','New-Partition','Format-Volume')) { Get-Command $name -ErrorAction Stop | Out-Null }
    $volume = Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($env:RUNNER_TEMP).Substring(0,1))
    if ($volume.FileSystemType -ne 'NTFS' -or $volume.SizeRemaining -lt 25GB) { throw 'Require NTFS temporary storage with at least 25 GiB free' }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    if ($LASTEXITCODE -ne 0 -or !$vs) { throw 'MSVC is unavailable; do not install a floating toolchain' }
    Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    $env:RUSTUP_TOOLCHAIN = '1.98.1'
    $env:CARGO_HOME = Join-Path $root 'cargo-common'
    $env:CARGO_BUILD_JOBS = '8'
    $env:CI = '1'; $env:NO_COLOR = '1'
    foreach ($name in @('RUSTFLAGS','NODE_OPTIONS','NODE_PATH','BUN_OPTIONS','FS_SAFE_NATIVE_MODE','FS_SAFE_CLONE_TEST_ROOT')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    $toolchain = Toolchain-Snapshot
    if ($toolchain.node -cne 'v24.21.0' -or $toolchain.pnpm -cne '12.4.2' -or $toolchain.rustc -notmatch 'commit-hash: 48a229ceaefd4985c50990b14116b6d856af0985' -or $toolchain.cargo -notmatch '^cargo 1\.98\.1 ') { throw 'Pinned build tool versions mismatch' }
    if ($toolchain.files.node.sha256 -cne 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32') { throw 'Pinned Node bytes mismatch' }
    Save-Json 'toolchain.json' $toolchain
    $toolchainJson = $toolchain | ConvertTo-Json -Depth 8 -Compress
    $prefixes = @((Join-Path $env:GITHUB_WORKSPACE 'baseline'), (Join-Path $env:GITHUB_WORKSPACE 'candidate'), $env:CARGO_HOME)
    $flags = @()
    foreach ($prefix in $prefixes) {
        $mapped = if ($prefix -ceq $env:CARGO_HOME) { '/fs-safe/cargo' } else { '/fs-safe/source' }
        $flags += "--remap-path-prefix=$prefix=$mapped"
        $flags += "--remap-path-prefix=$($prefix.Replace('\','/'))=$mapped"
    }
    $env:CARGO_ENCODED_RUSTFLAGS = [string]::Join([char]31, $flags)
    $before = @{}
    foreach ($role in $roles.Keys) { $before[$role] = Source-Snapshot $role 'before' }
    $baselinePaths = [Collections.Generic.HashSet[string]]::new([string[]]@($before.baseline.Keys), [StringComparer]::Ordinal)
    $candidatePaths = [Collections.Generic.HashSet[string]]::new([string[]]@($before.candidate.Keys), [StringComparer]::Ordinal)
    $changed = [Collections.Generic.HashSet[string]]::new([string[]]@($baselinePaths | Where-Object { $before.baseline[$_] -cne $before.candidate[$_] }), [StringComparer]::Ordinal)
    $expected = @('native/src/clone_windows.rs','native/src/copy_windows.rs','native/src/windows.rs','native/src/windows_security.rs')
    if (!$baselinePaths.SetEquals($candidatePaths) -or !$changed.SetEquals([string[]]$expected)) { throw 'Unexpected source delta outside the four reviewed Rust files' }
    Save-Json 'inputs.json' ([ordered]@{ roles=$roles; workflowSha=$env:PAIR_HARNESS_SHA; runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; flags=$flags; sharedPortableSha256='f47db7d77056d8a202019a8cd791accfd6893816a34ea41027d41699fd0153f3'; measurementExecuted=$false })

    $previous = @(Get-Disk | Select-Object Number,UniqueId)
    $owner = [ordered]@{ runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; image=$image; mountAttempted=$false; diskNumber=$null; diskUniqueId=$null; previousDiskNumbers=@($previous.Number); previousDiskIds=@($previous.UniqueId) }
    Save-Json 'owned-vhd.json' $owner
    $diskpart = Join-Path $root 'create-owned-vhd.txt'
    [IO.File]::WriteAllText($diskpart, "create vdisk file=`"$image`" maximum=16384 type=expandable`r`nexit`r`n", [Text.Encoding]::ASCII)
    Run-Step 'create-vhd' { & "$env:SystemRoot\System32\diskpart.exe" /s $diskpart }
    if (!(Test-Path -LiteralPath $image) -or (Get-DiskImage -ImagePath $image).Attached) { throw 'New VHD state mismatch' }
    $owner.mountAttempted = $true; Save-Json 'owned-vhd.json' $owner
    Mount-DiskImage -ImagePath $image -NoDriveLetter -Access ReadWrite | Out-Null
    $disks = @(Get-DiskImage -ImagePath $image | Get-Disk)
    if ($disks.Count -ne 1 -or $disks[0].IsBoot -or $disks[0].IsSystem -or $disks[0].PartitionStyle -ne 'RAW' -or $owner.previousDiskNumbers -contains $disks[0].Number -or $owner.previousDiskIds -contains $disks[0].UniqueId) { throw 'VHD is not a new owned blank disk' }
    $owner.diskNumber=$disks[0].Number; $owner.diskUniqueId=$disks[0].UniqueId; Save-Json 'owned-vhd.json' $owner
    Initialize-Disk -Number $owner.diskNumber -PartitionStyle GPT | Out-Null
    $refsVolume = New-Partition -DiskNumber $owner.diskNumber -UseMaximumSize -AssignDriveLetter | Format-Volume -FileSystem ReFS -NewFileSystemLabel 'fs-safe-native-pair' -Confirm:$false
    if ($refsVolume.FileSystemType -ne 'ReFS' -or !$refsVolume.DriveLetter) { throw 'ReFS unavailable; qualification cannot be skipped' }
    $refsRoot = "$($refsVolume.DriveLetter):\native-pair"
    New-Item -ItemType Directory -Path $refsRoot | Out-Null
    Save-Json 'refs-volume.json' ([ordered]@{ image=$image; diskNumber=$owner.diskNumber; diskUniqueId=$owner.diskUniqueId; volumeId=$refsVolume.UniqueId; fileSystem=[string]$refsVolume.FileSystemType; root=$refsRoot })
    $env:TEMP = Join-Path $root 'ntfs-tests'; $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP | Out-Null
    $artifacts = @()
    foreach ($role in $roles.Keys) {
        if ((Toolchain-Snapshot | ConvertTo-Json -Depth 8 -Compress) -cne $toolchainJson) { throw 'Common toolchain changed' }
        $source = Join-Path $env:GITHUB_WORKSPACE $role
        $env:CARGO_TARGET_DIR = Join-Path $source 'target-pair'
        if (Test-Path -LiteralPath $env:CARGO_TARGET_DIR) { throw 'Refuse reused native target directory' }
        Push-Location $source
        try {
            Run-Step "$role-install" { & pnpm.cmd --dir $source install --frozen-lockfile --store-dir (Join-Path $source '.pnpm-store') }
            Run-Step "$role-native-build" { & pnpm.cmd --dir $source native:build }
            $native = Join-Path $source 'packages\win32-x64-msvc\fs-safe-native.node'
            $bytes = [IO.File]::ReadAllBytes($native)
            $texts = @([Text.Encoding]::GetEncoding(28591).GetString($bytes).ToLowerInvariant(), [Text.Encoding]::Unicode.GetString($bytes).ToLowerInvariant(), [Text.Encoding]::Unicode.GetString($bytes,1,$bytes.Length-1).ToLowerInvariant())
            foreach ($prefix in @($prefixes + '.cargo-owned')) {
                foreach ($needle in @($prefix, $prefix.Replace('\','/'))) {
                    if (@($texts | Where-Object { $_.Contains($needle.ToLowerInvariant()) }).Count) { throw 'Native binary contains an unremapped physical role/Cargo prefix' }
                }
            }
            if (!$texts[0].Contains('/fs-safe/cargo')) { throw 'Common Cargo remap is not evidenced' }
            Save-Json "$role-prefix-scan.json" ([ordered]@{ sha256=(Hash $native); bytes=$bytes.Length; forbiddenOccurrences=0; commonCargoRemap=$true })
            Remove-Item Env:FS_SAFE_CLONE_TEST_ROOT -ErrorAction SilentlyContinue
            Run-Step "$role-native-ntfs" { & pnpm.cmd --dir $source native:test --locked --manifest-path (Join-Path $source 'Cargo.toml') }
            $env:FS_SAFE_CLONE_TEST_ROOT = $refsRoot
            try { Run-Step "$role-native-refs" { & pnpm.cmd --dir $source native:test --locked --manifest-path (Join-Path $source 'Cargo.toml') clone_windows::tests:: -- --nocapture } }
            finally { Remove-Item Env:FS_SAFE_CLONE_TEST_ROOT -ErrorAction SilentlyContinue }
            $refsLog = Get-Content (Join-Path $output "$role-native-refs.stdout.log") -Raw
            if ($refsLog -notmatch 'test clone_windows::tests::refs_tree_clones_large_sparse_files_and_rejects_lossy_sources \.\.\. ok' -or $refsLog -match 'ReFS unavailable') { throw 'Required sparse ReFS clone test did not execute successfully' }
            $packDir = Join-Path $source 'release-artifacts-pair'; New-Item -ItemType Directory -Path $packDir | Out-Null
            Push-Location (Join-Path $source 'packages\win32-x64-msvc')
            try { Run-Step "$role-pack" { & npm.cmd pack --json --ignore-scripts --pack-destination $packDir } }
            finally { Pop-Location }
            $packed = @(Get-Content (Join-Path $output "$role-pack.stdout.log") -Raw | ConvertFrom-Json)
            if ($packed.Count -ne 1 -or $packed[0].filename -cne 'openclaw-fs-safe-win32-x64-msvc-0.19.0.tgz') { throw 'Unexpected native package' }
            $tarball = Join-Path $packDir $packed[0].filename
            Copy-Item -LiteralPath $tarball -Destination (Join-Path $output "$role-native-0.19.0.tgz")
            $after = Source-Snapshot $role 'after'
            if (($before[$role] | ConvertTo-Json -Compress) -cne ($after | ConvertTo-Json -Compress)) { throw 'Source bytes changed during build' }
            $artifacts += [ordered]@{ role=$role; commit=$roles[$role].commit; tree=$roles[$role].tree; nativeSha256=(Hash $native); nativeBytes=(Get-Item $native).Length; tarSha256=(Hash $tarball); tarBytes=(Get-Item $tarball).Length }
        } finally { Pop-Location }
    }
    if ((Toolchain-Snapshot | ConvertTo-Json -Depth 8 -Compress) -cne $toolchainJson) { throw 'Toolchain changed after paired builds' }
    Save-Json 'paired-artifacts.json' $artifacts
} catch { $failure = $_.Exception.ToString() }
finally {
    try { Cleanup-OwnedImage } catch { $cleanupFailure = $_.Exception.ToString() }
    Save-Json 'result.json' ([ordered]@{ succeeded=(!$failure -and !$cleanupFailure); failure=$failure; cleanupFailure=$cleanupFailure; releaseAddonExecuted=$false; timedBenchmarkExecuted=$false; fixedStudyExecuted=$false })
}
if ($failure -or $cleanupFailure) { throw "Pair qualification failed. $failure Cleanup: $cleanupFailure" }
