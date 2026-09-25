param([switch]$CleanupOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$root = Join-Path $env:RUNNER_TEMP 'fs-safe-windows-info-proof'
$output = Join-Path $root 'artifacts'
$image = Join-Path $root 'owned-refs.vhdx'
$ownershipFile = Join-Path $output 'owned-vhd.json'
$taskOwnershipFile = Join-Path $output 'task-owner.json'
$cleanupPhase = if ($CleanupOnly) { 'workflow' } else { 'supervisor' }
$contract = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'contract.json') -Raw | ConvertFrom-Json
$roles = [ordered]@{ baseline=$contract.baseline; candidate=$contract.candidate }
$bodyDeadline = [DateTime]::UtcNow.AddMinutes($contract.caps.bodyMinutes)
$commandScript = Join-Path $PSScriptRoot 'command.ps1'
$commonInputDir = Join-Path $env:RUNNER_TEMP 'windows-info-common-root-input'

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
    Save-Json "$cleanupPhase-processes-before-cleanup.json" @($owned | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath)
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
    Save-Json "$cleanupPhase-processes-after-cleanup.json" @($remainingProcesses | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath)
    if ($remainingProcesses.Count) { throw 'Owned build processes remain; VHD cleanup is unresolved' }
}
function Assert-TaskOwnership {
    if (!(Test-Path -LiteralPath $taskOwnershipFile) -or (Get-Item -LiteralPath $taskOwnershipFile).Length -gt 16384) { throw 'Task cleanup authority is unavailable' }
    $taskOwner=Get-Content -LiteralPath $taskOwnershipFile -Raw | ConvertFrom-Json
    if ($taskOwner.runId -cne $env:GITHUB_RUN_ID -or $taskOwner.attempt -cne $env:GITHUB_RUN_ATTEMPT -or $taskOwner.root -cne $root) { throw 'Task cleanup authority mismatch' }
    return $taskOwner
}
function Cleanup-OwnedImage {
    $taskOwner=Assert-TaskOwnership
    $existing=@(Owned-BuildProcesses)
    if (@($existing | Where-Object { $_.CreationDate.ToUniversalTime() -lt ([DateTime]::Parse($taskOwner.createdAt)).ToUniversalTime() }).Count) { throw 'Matching process predates this task; refuse to consume it' }
    if (!(Test-Path -LiteralPath $ownershipFile)) {
        Settle-OwnedBuildProcesses
        Save-Json "$cleanupPhase-cleanup.json" ([ordered]@{ runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; imageCreated=$false; processesSettled=$true; attached=$false; deleted=$true })
        return
    }
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
    Save-Json "$cleanupPhase-cleanup.json" ([ordered]@{ runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; image=$image; processesSettled=$true; attached=$false; deleted=$true })
}
function Seal-Evidence([string]$filename) {
    $manifest=[ordered]@{}
    foreach ($file in (Get-ChildItem -LiteralPath $output -File | Where-Object { $_.Name -notlike 'evidence-manifest*.json' } | Sort-Object Name)) {
        $manifest[$file.Name]=[ordered]@{ bytes=$file.Length; sha256=(Hash $file.FullName) }
    }
    Save-Json $filename $manifest
}
if ($CleanupOnly) {
    if (!(Test-Path -LiteralPath $root)) { return }
    Assert-TaskOwnership | Out-Null
    try { Cleanup-OwnedImage } finally { Seal-Evidence 'evidence-manifest.json' }
    return
}
if (Test-Path -LiteralPath $root) { throw 'Refuse an existing pair-build directory' }
New-Item -ItemType Directory -Path $output | Out-Null
Save-Json 'task-owner.json' ([ordered]@{ runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; root=$root; createdAt=[DateTime]::UtcNow.ToString('o') })
$failure = $null
$cleanupFailure = $null
$steps = [Collections.Generic.List[object]]::new()
function Run-Command([string]$name, [string]$executable, [string[]]$arguments, [string]$cwd, [int]$seconds = 180) {
    if ([DateTime]::UtcNow -ge $bodyDeadline) { throw 'Fixed body deadline exceeded' }
    if ($name -cnotmatch '^[a-z0-9-]{1,90}$') { throw 'Invalid step name' }
    $requestFile = Join-Path $root "$name-command.json"
    [IO.File]::WriteAllText($requestFile, (ConvertTo-Json -InputObject ([ordered]@{ executable=$executable; arguments=@($arguments); cwd=$cwd }) -Depth 5), [Text.UTF8Encoding]::new($false))
    $stdout = Join-Path $output "$name.stdout.log"
    $stderr = Join-Path $output "$name.stderr.log"
    $record = [ordered]@{ name=$name; executable=$executable; arguments=@($arguments); exitCode=$null; pid=$null; startedAt=[DateTime]::UtcNow.ToString('o') }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = (Get-Command pwsh.exe).Source
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    foreach ($arg in @('-NoProfile','-File',$commandScript,'-Request',$requestFile)) { $process.StartInfo.ArgumentList.Add($arg) }
    $outFile = [IO.File]::Create($stdout); $errFile = [IO.File]::Create($stderr)
    $operationFailure=$null; $commandCleanupFailure=$null; $outTask=$null; $errTask=$null
    try {
        if (!$process.Start()) { throw 'Child did not start' }
        $record.pid=$process.Id; $record.processStart=$process.StartTime.ToUniversalTime().ToString('o')
        Save-Json "$name-process.json" $record
        $outTask=$process.StandardOutput.BaseStream.CopyToAsync($outFile)
        $errTask=$process.StandardError.BaseStream.CopyToAsync($errFile)
        $deadline=[DateTime]::UtcNow.AddSeconds($seconds)
        if ($deadline -gt $bodyDeadline) { $deadline=$bodyDeadline }
        while (!$process.WaitForExit(1000)) {
            if ([DateTime]::UtcNow -ge $deadline) { throw "$name exceeded fixed timeout" }
            if ($outFile.Length -gt $contract.caps.maxStepLogBytes -or $errFile.Length -gt $contract.caps.maxStepLogBytes) { throw "$name exceeded output cap" }
            if (@(Owned-BuildProcesses).Count -gt $contract.caps.maxActiveOwnedProcesses) { throw 'Owned process cap exceeded' }
        }
        if (![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask,$errTask), 10000)) { throw 'Child output streams did not settle' }
        $record.exitCode=[int]$process.ExitCode
        if ($outFile.Length -gt $contract.caps.maxStepLogBytes -or $errFile.Length -gt $contract.caps.maxStepLogBytes) { throw "$name exceeded output cap" }
        if ($record.exitCode -ne 0) { throw "$name exited $($record.exitCode)" }
    } catch { $operationFailure=$_.Exception.ToString() }
    finally {
        try {
            if ($record.pid -and !$process.HasExited) { $process.Kill($true); if (!$process.WaitForExit(20000)) { throw 'Owned child failed to settle' } }
            if ($record.pid -and $process.HasExited) { $record.exitCode=[int]$process.ExitCode }
            if ($outTask -and $errTask -and ![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask,$errTask),10000)) { throw 'Owned output streams did not settle' }
        } catch { $commandCleanupFailure=$_.Exception.ToString() }
        $outFile.Dispose(); $errFile.Dispose(); $process.Dispose()
        $record.failure=$operationFailure; $record.cleanupFailure=$commandCleanupFailure
        $record.completedAt=[DateTime]::UtcNow.ToString('o'); $steps.Add($record); Save-Json 'steps.json' $steps.ToArray()
    }
    if ($operationFailure -or $commandCleanupFailure) { throw "$name failed. Operation: $operationFailure Cleanup: $commandCleanupFailure" }
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
        rustc=(& rustup which rustc).Trim(); cargo=(& rustup which cargo).Trim(); bun=$bunExe; dumpbin=(Get-Command dumpbin.exe).Source
        compiler=(Get-Command cl.exe).Source; linker=(Get-Command link.exe).Source
        ucrt=(Join-Path $env:WindowsSdkDir "Lib\$($env:WindowsSDKVersion.TrimEnd('\'))\ucrt\x64\ucrt.lib")
        kernel32=(Join-Path $env:WindowsSdkDir "Lib\$($env:WindowsSDKVersion.TrimEnd('\'))\um\x64\kernel32.lib")
    }
    $files = [ordered]@{}
    foreach ($name in $paths.Keys) { $files[$name] = [ordered]@{ path=$paths[$name]; sha256=(Hash $paths[$name]) } }
    return [ordered]@{ rustc=(& rustc --version --verbose)-join "`n"; cargo=(& cargo --version).Trim(); node=(& node --version).Trim(); pnpm=(& pnpm.cmd --version).Trim(); bun=(& $bunExe --version).Trim(); msvc=$env:VCToolsVersion; windowsSdk=$env:WindowsSDKVersion; files=$files }
}

function Complete-BunOperation($failure, [object[]]$resources) {
    $cleanupFailures=[Collections.Generic.List[Exception]]::new()
    foreach ($resource in $resources) {
        if ($null -eq $resource) { continue }
        try { $resource.Dispose() } catch { $cleanupFailures.Add($_.Exception) }
    }
    if ($cleanupFailures.Count) {
        if ($failure) { $cleanupFailures.Insert(0,$failure.Exception) }
        throw [AggregateException]::new('Bun operation or resource cleanup failed.', $cleanupFailures.ToArray())
    }
    if ($failure) { throw $failure }
}

function Copy-BunStream([IO.Stream]$source, [string]$destination, [long]$maximumBytes, [string]$capMessage,
    [switch]$Async, [Threading.CancellationToken]$cancellationToken = [Threading.CancellationToken]::None) {
    $file=$null; $failure=$null; $total=0L
    try {
        $file=[IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer=[byte[]]::new(65536)
        while ($true) {
            $length=if ($Async) { $source.ReadAsync($buffer,0,$buffer.Length,$cancellationToken).GetAwaiter().GetResult() } else { $source.Read($buffer,0,$buffer.Length) }
            if ($length -eq 0) { break }
            $total+=$length; if ($total -gt $maximumBytes) { throw $capMessage }
            $file.Write($buffer,0,$length)
        }
    } catch { $failure=$_ }
    finally { Complete-BunOperation $failure @($file,$source) }
    return $total
}

function Prepare-Bun {
    $archive=Join-Path $root 'bun.zip'
    $client=[Net.Http.HttpClient]::new(); $cancellation=[Threading.CancellationTokenSource]::new(180000)
    $response=$null; $failure=$null
    try {
        $response=$client.GetAsync($contract.bunArchiveUrl, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode() | Out-Null
        $bunInputStream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        Copy-BunStream $bunInputStream $archive $contract.bunArchiveBytes 'Bun download cap exceeded' -Async -CancellationToken $cancellation.Token | Out-Null
        if ((Get-Item -LiteralPath $archive).Length -ne $contract.bunArchiveBytes -or (Hash $archive) -cne $contract.bunArchiveSha256) { throw 'Bun archive pin mismatch' }
    } catch { $failure=$_ }
    finally { Complete-BunOperation $failure @($response,$cancellation,$client) }
    $directory=Join-Path $root 'bun'; New-Item -ItemType Directory -Path $directory | Out-Null
    $zip=[IO.Compression.ZipFile]::OpenRead($archive); $failure=$null
    try {
        if ($zip.Entries.Count -gt $contract.caps.maxBunMembers) { throw 'Bun ZIP member cap exceeded' }
        $entries=@($zip.Entries | Where-Object { !$_.FullName.EndsWith('/') })
        if ($entries.Count -ne 1 -or $entries[0].FullName -cne 'bun-windows-x64/bun.exe' -or $entries[0].Length -gt $contract.caps.maxBunExpandedBytes) { throw 'Bun ZIP contents differ from admitted package' }
        $total=Copy-BunStream ($entries[0].Open()) (Join-Path $directory 'bun.exe') $contract.caps.maxBunExpandedBytes 'Bun extraction cap exceeded'
        if ($total -ne $entries[0].Length) { throw 'Bun expanded length mismatch' }
    } catch { $failure=$_ }
    finally { Complete-BunOperation $failure @($zip) }
    return Join-Path $directory 'bun.exe'
}
try {
    if (!$IsWindows -or [IntPtr]::Size -ne 8 -or (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors -ne 16) { throw 'Require native Windows x64 with exactly 16 CPUs' }
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Owned ReFS proof requires elevation' }
    foreach ($name in @('Get-Disk','Get-DiskImage','Mount-DiskImage','Dismount-DiskImage','Initialize-Disk','New-Partition','Format-Volume')) { Get-Command $name -ErrorAction Stop | Out-Null }
    $volume=Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($env:RUNNER_TEMP).Substring(0,1))
    if ([string]$volume.FileSystemType -cne 'NTFS' -or $volume.SizeRemaining -lt 25GB) { throw 'Require NTFS temporary storage with 25 GiB free' }
    $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    if ($LASTEXITCODE -ne 0 -or !$vs) { throw 'MSVC missing; do not replace the pinned compiler' }
    Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
    Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    $env:RUSTUP_TOOLCHAIN=$contract.rustVersion
    $env:CARGO_HOME=Join-Path $root 'cargo-common'; $env:CARGO_BUILD_JOBS='8'
    $env:CI='1'; $env:NO_COLOR='1'
    foreach ($name in @('RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','NODE_OPTIONS','NODE_PATH','BUN_OPTIONS','FS_SAFE_NATIVE_MODE','FS_SAFE_CLONE_TEST_ROOT')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    $bunExe=Prepare-Bun
    $node=(Get-Command node.exe).Source; $pnpm=(Get-Command pnpm.cmd).Source; $npm=(Get-Command npm.cmd).Source; $dumpbin=(Get-Command dumpbin.exe).Source
    $toolchain=Toolchain-Snapshot
    if ($toolchain.node -cne $contract.nodeVersion -or $toolchain.pnpm -cne '12.4.2' -or $toolchain.bun -cne $contract.bunVersion -or $toolchain.rustc -notmatch [regex]::Escape($contract.rustCommit) -or $toolchain.cargo -notmatch '^cargo 1\.98\.1 ') { throw 'Pinned build/runtime versions mismatch' }
    if ($toolchain.files.node.sha256 -cne $contract.nodeSha256 -or $toolchain.msvc.TrimEnd('\') -cne $contract.msvc -or $toolchain.windowsSdk.TrimEnd('\') -cne $contract.windowsSdk) { throw 'Pinned Node/MSVC/SDK mismatch' }
    Save-Json 'toolchain.json' $toolchain; $toolchainJson=$toolchain | ConvertTo-Json -Depth 8 -Compress
    foreach ($runtime in @('node','bun')) {
        $executable=if ($runtime -ceq 'node') { $node } else { $bunExe }
        Run-Command "$runtime-host-exports" $dumpbin @('/exports',$executable) $root
        $exports=Get-Content -LiteralPath (Join-Path $output "$runtime-host-exports.stdout.log") -Raw
        foreach ($symbol in $contract.bridgeExports) {
            if ($exports -cnotmatch "(?m)^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+$symbol\s*$") { throw "$runtime lacks required host export $symbol" }
        }
    }
    foreach ($digest in @($env:COMMON_ROOT_SHA256,$env:COMMON_ROOT_MANIFEST_SHA256,$env:COMMON_ROOT_PROOF_SHA256)) {
        if ($digest -cnotmatch '^[0-9a-f]{64}$') { throw 'Common root digest output missing' }
    }
    $commonFiles=@(Get-ChildItem -LiteralPath $commonInputDir -Force)
    $commonNames=[Collections.Generic.HashSet[string]]::new([string[]]@($commonFiles.Name),[StringComparer]::Ordinal)
    if ($commonFiles.Count -ne 3 -or !$commonNames.SetEquals([string[]]@('openclaw-fs-safe-common-root.tgz','common-root-manifest.json','preparation-proof.json')) -or @($commonFiles | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }).Count -or ($commonFiles | Measure-Object Length -Sum).Sum -gt $contract.caps.maxPreparationArtifactBytes) { throw 'Common artifact file set or size invalid' }
    $rootTar=Join-Path $commonInputDir 'openclaw-fs-safe-common-root.tgz'
    $commonManifest=Join-Path $commonInputDir 'common-root-manifest.json'
    $commonProof=Join-Path $commonInputDir 'preparation-proof.json'
    if ((Hash $rootTar) -cne $env:COMMON_ROOT_SHA256 -or (Hash $commonManifest) -cne $env:COMMON_ROOT_MANIFEST_SHA256 -or (Hash $commonProof) -cne $env:COMMON_ROOT_PROOF_SHA256) { throw 'Common artifact payload digest mismatch' }
    $preparation=Get-Content -LiteralPath $commonProof -Raw | ConvertFrom-Json
    if ($preparation.repository -cne 'openclaw/fs-safe' -or $preparation.runId -cne $env:GITHUB_RUN_ID -or $preparation.attempt -cne $env:GITHUB_RUN_ATTEMPT -or $preparation.harnessSha -cne $env:PAIR_HARNESS_SHA -or $preparation.source.commit -cne $contract.baseline.commit -or $preparation.source.tree -cne $contract.baseline.tree -or $preparation.candidate.commit -cne $contract.candidate.commit -or $preparation.candidate.tree -cne $contract.candidate.tree -or $preparation.commonRootSha256 -cne $env:COMMON_ROOT_SHA256 -or $preparation.manifestSha256 -cne $env:COMMON_ROOT_MANIFEST_SHA256 -or !$preparation.matchingMembersExceptPublishedWasm -or !$preparation.tarModesMatched -or $preparation.nativeAddonMembers -ne 0 -or $preparation.wasmRebuilt -or $preparation.nativeRebuilt -or $preparation.productExecuted) { throw 'Common preparation provenance invalid' }
    Copy-Item -LiteralPath $commonManifest -Destination (Join-Path $output 'common-root-manifest.json')
    Copy-Item -LiteralPath $commonProof -Destination (Join-Path $output 'common-root-preparation-proof.json')
    Copy-Item -LiteralPath (Join-Path $env:RUNNER_TEMP 'windows-info-common-root-transport.json') -Destination (Join-Path $output 'common-root-transport.json')
    Run-Command 'root-input' $node @((Join-Path $PSScriptRoot 'artifacts.mjs'),'root',$rootTar,$commonManifest,$env:COMMON_ROOT_SHA256,$env:COMMON_ROOT_MANIFEST_SHA256,(Join-Path $output 'root-input.json')) $root
    $prefixes=@((Join-Path $env:GITHUB_WORKSPACE 'baseline'),(Join-Path $env:GITHUB_WORKSPACE 'candidate'),$env:CARGO_HOME)
    $flags=@()
    foreach ($prefix in $prefixes) {
        $mapped=if ($prefix -ceq $env:CARGO_HOME) { '/fs-safe/cargo' } else { '/fs-safe/source' }
        $flags+="--remap-path-prefix=$prefix=$mapped"; $flags+="--remap-path-prefix=$($prefix.Replace('\','/'))=$mapped"
    }
    $env:CARGO_ENCODED_RUSTFLAGS=[string]::Join([char]31,$flags)
    $before=@{}; foreach ($role in $roles.Keys) { $before[$role]=Source-Snapshot $role 'before' }
    $baselinePaths=[Collections.Generic.HashSet[string]]::new([string[]]@($before.baseline.Keys),[StringComparer]::Ordinal)
    $candidatePaths=[Collections.Generic.HashSet[string]]::new([string[]]@($before.candidate.Keys),[StringComparer]::Ordinal)
    $changed=[Collections.Generic.HashSet[string]]::new([string[]]@($baselinePaths | Where-Object { $before.baseline[$_] -cne $before.candidate[$_] }),[StringComparer]::Ordinal)
    if (!$baselinePaths.SetEquals($candidatePaths) -or !$changed.SetEquals([string[]]$contract.changedFiles)) { throw 'Product source delta differs from the exact reviewed two-file change' }
    Save-Json 'inputs.json' ([ordered]@{ roles=$roles; workflowSha=$env:PAIR_HARNESS_SHA; runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; flags=$flags; rootSha256=$env:COMMON_ROOT_SHA256; rootOrigin='Fresh Linux CI baseline bfc2749 TS/assets assembly; published 0.19.0 common WASM only'; originalBaselineRootSha256=$contract.originalBaselineRootSha256; publishedWasmSha256=$contract.publishedWasm.sha256; commonManifestSha256=$env:COMMON_ROOT_MANIFEST_SHA256; commonPreparationSha256=$env:COMMON_ROOT_PROOF_SHA256; contractSha256=(Hash (Join-Path $PSScriptRoot 'contract.json')); measurementExecuted=$false })
    $previous=@(Get-Disk | Select-Object Number,UniqueId)
    $owner=[ordered]@{ runId=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; image=$image; mountAttempted=$false; diskNumber=$null; diskUniqueId=$null; previousDiskNumbers=@($previous.Number); previousDiskIds=@($previous.UniqueId) }
    Save-Json 'owned-vhd.json' $owner
    $diskpart=Join-Path $root 'create-owned-vhd.txt'
    [IO.File]::WriteAllText($diskpart,"create vdisk file=`"$image`" maximum=$($contract.caps.vhdMiB) type=expandable`r`nexit`r`n",[Text.Encoding]::ASCII)
    Run-Command 'create-vhd' "$env:SystemRoot\System32\diskpart.exe" @('/s',$diskpart) $root
    if (!(Test-Path -LiteralPath $image) -or (Get-DiskImage -ImagePath $image).Attached) { throw 'New VHD state mismatch' }
    $owner.mountAttempted=$true; Save-Json 'owned-vhd.json' $owner
    Mount-DiskImage -ImagePath $image -NoDriveLetter -Access ReadWrite | Out-Null
    $disks=@(Get-DiskImage -ImagePath $image | Get-Disk)
    if ($disks.Count -ne 1 -or $disks[0].IsBoot -or $disks[0].IsSystem -or $disks[0].PartitionStyle -ne 'RAW' -or $owner.previousDiskNumbers -contains $disks[0].Number -or $owner.previousDiskIds -contains $disks[0].UniqueId) { throw 'VHD is not a new owned blank disk' }
    $owner.diskNumber=$disks[0].Number; $owner.diskUniqueId=$disks[0].UniqueId; Save-Json 'owned-vhd.json' $owner
    Initialize-Disk -Number $owner.diskNumber -PartitionStyle GPT | Out-Null
    $refsVolume=New-Partition -DiskNumber $owner.diskNumber -UseMaximumSize -AssignDriveLetter | Format-Volume -FileSystem ReFS -NewFileSystemLabel 'fs-safe-win-info' -Confirm:$false
    if ([string]$refsVolume.FileSystemType -cne 'ReFS' -or !$refsVolume.DriveLetter) { throw 'Required ReFS is unavailable; no skipped witness' }
    $refsRoot="$($refsVolume.DriveLetter):\windows-info-proof"; New-Item -ItemType Directory -Path $refsRoot | Out-Null
    Save-Json 'refs-volume.json' ([ordered]@{ image=$image; diskNumber=$owner.diskNumber; diskUniqueId=$owner.diskUniqueId; volumeId=$refsVolume.UniqueId; fileSystem=[string]$refsVolume.FileSystemType; root=$refsRoot })
    $env:TEMP=Join-Path $root 'ntfs-fixtures'; $env:TMP=$env:TEMP; New-Item -ItemType Directory -Path $env:TEMP | Out-Null
    Save-Json 'ntfs-volume.json' ([ordered]@{ fileSystem=[string]$volume.FileSystemType; volumeId=$volume.UniqueId; root=$env:TEMP })
    $binaries=@{}; $tarballs=@{}
    foreach ($role in $roles.Keys) {
        if ((Toolchain-Snapshot | ConvertTo-Json -Depth 8 -Compress) -cne $toolchainJson) { throw 'Common toolchain changed' }
        $source=Join-Path $env:GITHUB_WORKSPACE $role; $env:CARGO_TARGET_DIR=Join-Path $source 'target-pair'
        if (Test-Path -LiteralPath $env:CARGO_TARGET_DIR) { throw 'Refuse reused native target' }
        Run-Command "$role-install" $pnpm @('--dir',$source,'install','--frozen-lockfile','--store-dir',(Join-Path $source '.pnpm-store')) $source $contract.caps.installSeconds
        Run-Command "$role-native-build" $pnpm @('--dir',$source,'native:build') $source $contract.caps.buildSeconds
        $binary=Join-Path $source 'packages\win32-x64-msvc\fs-safe-native.node'; $binaries[$role]=$binary
        $bytes=[IO.File]::ReadAllBytes($binary)
        $texts=@([Text.Encoding]::GetEncoding(28591).GetString($bytes).ToLowerInvariant(),[Text.Encoding]::Unicode.GetString($bytes).ToLowerInvariant(),[Text.Encoding]::Unicode.GetString($bytes,1,$bytes.Length-1).ToLowerInvariant())
        foreach ($prefix in $prefixes) { foreach ($needle in @($prefix,$prefix.Replace('\','/'))) { if (@($texts | Where-Object { $_.Contains($needle.ToLowerInvariant()) }).Count) { throw 'Native binary retains physical role prefix' } } }
        if (!$texts[0].Contains('/fs-safe/cargo')) { throw 'Common Cargo remap not evidenced' }
        Save-Json "$role-prefix-scan.json" ([ordered]@{ sha256=(Hash $binary); bytes=$bytes.Length; forbiddenOccurrences=0; commonCargoRemap=$true })
        Copy-Item -LiteralPath $binary -Destination (Join-Path $output "$role.node")
        $declaration=Join-Path $source 'native\index.d.ts'; Copy-Item -LiteralPath $declaration -Destination (Join-Path $output "$role-native.d.ts")
        foreach ($kind in @('headers','imports','exports','symbols','unwindinfo','disasm:bytes')) {
            $label=$kind.Replace(':','-'); Run-Command "$role-$label" $dumpbin @("/$kind",$binary) $source
        }
        $packDir=Join-Path $root "$role-pack"; New-Item -ItemType Directory -Path $packDir | Out-Null
        Run-Command "$role-pack" $npm @('pack','--json','--ignore-scripts','--pack-destination',$packDir) (Join-Path $source 'packages\win32-x64-msvc')
        $packed=@(Get-Content -LiteralPath (Join-Path $output "$role-pack.stdout.log") -Raw | ConvertFrom-Json)
        if ($packed.Count -ne 1 -or $packed[0].filename -cne 'openclaw-fs-safe-win32-x64-msvc-0.19.0.tgz') { throw 'Unexpected native package' }
        $tar=Join-Path $packDir $packed[0].filename; $tarballs[$role]=$tar
        Copy-Item -LiteralPath $tar -Destination (Join-Path $output "$role-native-0.19.0.tgz")
        Run-Command "$role-artifact" $node @((Join-Path $PSScriptRoot 'artifacts.mjs'),'native',$tar,$binary,$declaration,(Join-Path $output "$role-native-manifest.json")) $root
        $after=Source-Snapshot $role 'after'
        if (($before[$role] | ConvertTo-Json -Compress) -cne ($after | ConvertTo-Json -Compress)) { throw 'Source changed during native build' }
    }
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    foreach ($role in $roles.Keys) { foreach ($runtime in $contract.runtimes) { foreach ($filesystem in $contract.filesystems) {
        $id="$role-$runtime-$filesystem"; $step=$id.ToLowerInvariant()
        $consumer=Join-Path $root "$id-consumer"; New-Item -ItemType Directory -Path $consumer | Out-Null
        [IO.File]::WriteAllText((Join-Path $consumer 'package.json'),'{"name":"fs-safe-win-info-consumer","version":"1.0.0","private":true,"type":"module"}',[Text.UTF8Encoding]::new($false))
        Run-Command "$step-install" $npm @('install','--ignore-scripts','--omit=dev','--no-audit','--no-fund','--package-lock=false',$rootTar,$tarballs[$role]) $consumer $contract.caps.installSeconds
        $fixtureParent=if ($filesystem -ceq 'ReFS') { $refsRoot } else { $env:TEMP }
        $fixture=Join-Path $fixtureParent $id; New-Item -ItemType Directory -Path $fixture | Out-Null
        $request=Join-Path $root "$id-request.json"
        $worker=[ordered]@{ role=$role; runtime=$runtime; filesystem=$filesystem; consumer=$consumer; fixture=$fixture; rootSha256=$env:COMMON_ROOT_SHA256; rootManifest=$commonManifest; rootManifestSha256=$env:COMMON_ROOT_MANIFEST_SHA256; nativeSha256=(Hash $binaries[$role]); pwsh=(Get-Command pwsh.exe).Source; fixtureScript=(Join-Path $PSScriptRoot 'fixture.ps1'); output=(Join-Path $output "$id.json") }
        [IO.File]::WriteAllText($request,($worker | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
        $executable=if ($runtime -ceq 'node') { $node } else { $bunExe }
        $workerArguments=@((Join-Path $PSScriptRoot 'installed.mjs'),$request)
        if ($runtime -ceq 'bun') { $workerArguments=@('--no-install')+$workerArguments }
        Run-Command "$step-installed" $executable $workerArguments $consumer $contract.caps.workerSeconds
    } } }
    Run-Command 'comparison' $node @((Join-Path $PSScriptRoot 'artifacts.mjs'),'compare',$output) $root
    if ((Toolchain-Snapshot | ConvertTo-Json -Depth 8 -Compress) -cne $toolchainJson) { throw 'Toolchain changed after qualification' }
    $total=(Get-ChildItem -LiteralPath $output -File -Recurse | Measure-Object Length -Sum).Sum
    if ($total -gt $contract.caps.maxArtifactBytes) { throw 'Artifact cap exceeded' }
} catch { $failure=$_.Exception.ToString() }
finally {
    try { Cleanup-OwnedImage } catch { $cleanupFailure=$_.Exception.ToString() }
    $dispatched=@(Get-ChildItem -LiteralPath $output -Filter '*-installed-process.json' -File).Count
    $observed=[Collections.Generic.List[string]]::new()
    foreach ($role in $roles.Keys) { foreach ($runtime in $contract.runtimes) { foreach ($filesystem in $contract.filesystems) {
        $name="$role-$runtime-$filesystem"; $file=Join-Path $output "$name.json"
        if (Test-Path -LiteralPath $file) {
            try { $lane=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json; if (@($lane.nativeCalls).Count -gt 0) { $observed.Add($name) } }
            catch { if (!$failure) { $failure=$_.Exception.ToString() } }
        }
    } } }
    $executed=if ($observed.Count) { $true } elseif ($dispatched) { $null } else { $false }
    Save-Json 'result.json' ([ordered]@{ succeeded=(!$failure -and !$cleanupFailure); failure=$failure; cleanupFailure=$cleanupFailure; installedWorkersDispatched=$dispatched; observedReleaseAddonLanes=@($observed); releaseAddonExecuted=$executed; incompleteWorkers=($dispatched -gt $observed.Count); timedBenchmarkExecuted=$false; fixedStudyExecuted=$false; mainPerformanceCredit=$false })
    Seal-Evidence 'evidence-manifest-supervisor.json'
}
if ($failure -or $cleanupFailure) { throw "Windows information qualification failed. $failure Cleanup: $cleanupFailure" }
