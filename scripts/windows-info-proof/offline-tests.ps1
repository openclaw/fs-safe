$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$commandScript=Join-Path $PSScriptRoot 'command.ps1'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'supervisor.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Supervisor does not parse' }
foreach ($name in @('Save-Json','Run-Command','Assert-TaskOwnership')) {
    $selected=@($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name },$false))
    if ($selected.Count -ne 1) { throw "Missing unique $name definition" }
    Invoke-Expression $selected[0].Extent.Text
}
$actualPwsh=(Microsoft.PowerShell.Core\Get-Command pwsh).Source
$node=(Microsoft.PowerShell.Core\Get-Command node).Source
function Get-Command([string]$Name) {
    if ($Name -cne 'pwsh.exe') { return Microsoft.PowerShell.Core\Get-Command $Name }
    return [pscustomobject]@{ Source=$actualPwsh }
}
function Owned-BuildProcesses { @() }
$root=Join-Path ([IO.Path]::GetTempPath()) ("fs-safe-win-info-offline-"+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$output=Join-Path $root 'artifacts'; New-Item -ItemType Directory -Path $output | Out-Null
$contract=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'contract.json') -Raw | ConvertFrom-Json
$contract.caps.maxStepLogBytes=32768
$bodyDeadline=[DateTime]::UtcNow.AddMinutes(2)
$steps=[Collections.Generic.List[object]]::new()
$passed=[Collections.Generic.List[string]]::new()
try {
    $values=@('space value','quote"value','back\slash','nonascii-é')
    Run-Command 'argument-roundtrip' $node (@('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))')+$values) $root 15
    $actual=@(Get-Content -LiteralPath (Join-Path $output 'argument-roundtrip.stdout.log') -Raw | ConvertFrom-Json)
    if (($actual | ConvertTo-Json -Compress) -cne ($values | ConvertTo-Json -Compress)) { throw 'Argument boundaries changed' }
    $passed.Add('structured-argument-roundtrip')
    try { Run-Command 'nonzero' $node @('-e','process.stderr.write("expected failure");process.exitCode=7') $root 15; throw 'Expected nonzero rejection' }
    catch { if ($_.Exception.Message -notmatch 'nonzero exited 7') { throw } }
    if ($steps[-1].exitCode -ne 7 -or !$steps[-1].failure -or $steps[-1].cleanupFailure) { throw 'Nonzero failure receipt changed' }
    $passed.Add('nonzero-exit-and-original-failure-receipt')
    try { Run-Command 'timeout' $node @('-e','setInterval(()=>{},1000)') $root 1; throw 'Expected timeout rejection' }
    catch { if ($_.Exception.Message -notmatch 'exceeded fixed timeout') { throw } }
    if ($null -eq $steps[-1].exitCode -or !$steps[-1].failure -or $steps[-1].cleanupFailure) { throw 'Timeout failed to settle its process' }
    $passed.Add('bounded-timeout-with-terminal-exit')
    try { Run-Command 'output-cap' $node @('-e','process.stdout.write("x".repeat(65536))') $root 15; throw 'Expected output cap rejection' }
    catch { if ($_.Exception.Message -notmatch 'exceeded output cap') { throw } }
    if ($steps[-1].exitCode -ne 0 -or !$steps[-1].failure -or $steps[-1].cleanupFailure) { throw 'Output cap receipt changed' }
    $passed.Add('output-cap-with-terminal-exit')
    function Owned-BuildProcesses { 1..129 }
    try { Run-Command 'process-cap' $node @('-e','setInterval(()=>{},1000)') $root 15; throw 'Expected process cap rejection' }
    catch { if ($_.Exception.Message -notmatch 'Owned process cap exceeded') { throw } }
    if ($null -eq $steps[-1].exitCode -or !$steps[-1].failure -or $steps[-1].cleanupFailure) { throw 'Process cap failed to settle its child' }
    $passed.Add('owned-process-cap-with-terminal-exit')
    $env:GITHUB_RUN_ID='123'; $env:GITHUB_RUN_ATTEMPT='1'
    $taskOwnershipFile=Join-Path $output 'task-owner.json'
    Save-Json 'task-owner.json' ([ordered]@{ runId='123'; attempt='1'; root=$root; createdAt=[DateTime]::UtcNow.ToString('o') })
    if ((Assert-TaskOwnership).runId -cne '123') { throw 'Matching ownership rejected' }
    $env:GITHUB_RUN_ATTEMPT='2'
    try { Assert-TaskOwnership | Out-Null; throw 'Expected ownership rejection' }
    catch { if ($_.Exception.Message -notmatch 'Task cleanup authority mismatch') { throw } }
    $passed.Add('cleanup-authority-binds-exact-run-and-attempt')
    [ordered]@{ phase='offline supervisor only'; productExecuted=$false; windowsDiskOperations=$false; passed=@($passed); steps=@($steps) } | ConvertTo-Json -Depth 8
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
