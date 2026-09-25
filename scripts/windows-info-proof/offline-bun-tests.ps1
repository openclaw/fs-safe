$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'supervisor.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Supervisor does not parse' }
foreach ($name in @('Complete-BunOperation','Copy-BunStream')) {
    $selected=@($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name },$false))
    if ($selected.Count -ne 1) { throw "Missing unique $name definition" }
    Invoke-Expression $selected[0].Extent.Text
}
Add-Type -TypeDefinition @'
using System;
using System.IO;
public sealed class BunProbeStream : MemoryStream {
    public bool WasDisposed { get; private set; }
    public bool FailRead { get; set; }
    public bool FailDispose { get; set; }
    public BunProbeStream(byte[] bytes) : base(bytes, false) {}
    public override int Read(byte[] buffer, int offset, int count) {
        if (FailRead) throw new IOException("synthetic-read-failure");
        return base.Read(buffer, offset, count);
    }
    protected override void Dispose(bool disposing) {
        WasDisposed = true;
        base.Dispose(disposing);
        if (FailDispose) throw new IOException("synthetic-dispose-failure");
    }
}
'@
function Expect-Failure([scriptblock]$operation) {
    $caught=$null
    try { & $operation | Out-Null } catch { $caught=$_ }
    if (!$caught) { throw 'Expected operation to fail' }
    return $caught
}
function Assert-Bytes([string]$path, [byte[]]$expected) {
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [Convert]::ToBase64String($expected)) { throw 'File bytes changed' }
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('fs-safe-bun-stream-offline-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$passed=[Collections.Generic.List[string]]::new()
$bytes=[byte[]]@(1,2,3,4,5,6,7,8); $sentinel=[byte[]]@(91,92,93)
try {
    foreach ($existing in @($false,$true)) {
        $path=Join-Path $root "archive-$existing.zip"
        if ($existing) { [IO.File]::WriteAllBytes($path,$sentinel) }
        $source=[BunProbeStream]::new($bytes)
        $response=[Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::OK)
        $response.Content=[Net.Http.StreamContent]::new($source)
        $operation={
            $failure=$null
            try {
                $stream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                Copy-BunStream $stream $path $bytes.Length 'Bun download cap exceeded' -Async | Out-Null
            } catch { $failure=$_ }
            finally { Complete-BunOperation $failure @($response) }
        }
        if ($existing) {
            $caught=Expect-Failure $operation
            if ($caught.Exception.GetBaseException() -isnot [IO.IOException]) { throw 'Existing archive did not fail with IOException' }
            Assert-Bytes $path $sentinel
        } else { & $operation; Assert-Bytes $path $bytes }
        if (!$source.WasDisposed) { throw 'HTTP input stream leaked' }
        $caught=Expect-Failure { $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult() }
        if ($caught.Exception.GetBaseException() -isnot [ObjectDisposedException]) { throw 'HTTP response content was not disposed' }
        $passed.Add("async-http-stream-existing-$existing")
    }

    $zipData=[IO.MemoryStream]::new()
    $zipWriter=[IO.Compression.ZipArchive]::new($zipData,[IO.Compression.ZipArchiveMode]::Create,$true)
    $entryStream=$zipWriter.CreateEntry('bun-windows-x64/bun.exe').Open()
    $entryStream.Write($bytes,0,$bytes.Length); $entryStream.Dispose(); $zipWriter.Dispose()
    $zipBytes=$zipData.ToArray(); $zipData.Dispose()
    foreach ($existing in @($false,$true)) {
        $path=Join-Path $root "executable-$existing.exe"
        if ($existing) { [IO.File]::WriteAllBytes($path,$sentinel) }
        $zip=[IO.Compression.ZipArchive]::new([IO.MemoryStream]::new($zipBytes,$false),[IO.Compression.ZipArchiveMode]::Read)
        try {
            $source=$zip.Entries[0].Open()
            if ($existing) {
                $caught=Expect-Failure { Copy-BunStream $source $path $bytes.Length 'Bun extraction cap exceeded' }
                if ($caught.Exception.GetBaseException() -isnot [IO.IOException]) { throw 'Existing executable did not fail with IOException' }
                Assert-Bytes $path $sentinel
            } else {
                $total=Copy-BunStream $source $path $bytes.Length 'Bun extraction cap exceeded'
                if ($total -ne $zip.Entries[0].Length) { throw 'ZIP extraction length changed' }
                Assert-Bytes $path $bytes
            }
            if ($source.CanRead) { throw 'ZIP input stream leaked' }
        } finally { $zip.Dispose() }
        $passed.Add("sync-zip-stream-existing-$existing")
    }

    foreach ($async in @($false,$true)) {
        $source=[BunProbeStream]::new($bytes); $path=Join-Path $root "cap-$async"
        $caught=Expect-Failure { Copy-BunStream $source $path 4 'synthetic-copy-cap' -Async:$async }
        if ($caught.Exception.ToString() -notmatch 'synthetic-copy-cap' -or !$source.WasDisposed) { throw 'Copy cap or input cleanup changed' }
        if ((Get-Item -LiteralPath $path).Length -gt 4) { throw 'Copy wrote beyond its cap' }
        $passed.Add("bounded-copy-async-$async")
    }
    $source=[BunProbeStream]::new($bytes); $source.FailDispose=$true
    $path=Join-Path $root 'existing-and-dispose-failure'; [IO.File]::WriteAllBytes($path,$sentinel)
    $caught=Expect-Failure { Copy-BunStream $source $path 8 'unused cap' }
    $aggregate=$caught.Exception.GetBaseException()
    if ($aggregate -isnot [AggregateException] -or $aggregate.InnerExceptions.Count -ne 2 -or $aggregate.InnerExceptions[0].GetBaseException() -isnot [IO.IOException] -or $aggregate.InnerExceptions[0].ToString() -notmatch [regex]::Escape($path) -or $aggregate.InnerExceptions[1].ToString() -notmatch 'synthetic-dispose-failure') { throw 'Existing-file failure was masked by disposal' }
    Assert-Bytes $path $sentinel
    $passed.Add('existing-file-and-disposal-failures-retained-original-bytes')
    $source=[BunProbeStream]::new($bytes); $source.FailRead=$true; $source.FailDispose=$true
    $path=Join-Path $root 'read-and-dispose-failure'
    $caught=Expect-Failure { Copy-BunStream $source $path 8 'unused cap' }
    if ($caught.Exception.ToString() -notmatch 'synthetic-read-failure' -or $caught.Exception.ToString() -notmatch 'synthetic-dispose-failure' -or !$source.WasDisposed) { throw 'Primary or disposal failure was masked' }
    $reopened=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None); $reopened.Dispose()
    $passed.Add('primary-and-disposal-failures-retained-output-closed')
    $first=[BunProbeStream]::new($bytes); $first.FailDispose=$true; $second=[BunProbeStream]::new($bytes)
    $caught=Expect-Failure { Complete-BunOperation $null @($first,$second) }
    if ($caught.Exception.ToString() -notmatch 'synthetic-dispose-failure' -or !$first.WasDisposed -or !$second.WasDisposed) { throw 'Disposal failure skipped a later owner' }
    $passed.Add('cleanup-failure-reported-all-owners-attempted')
    $source=[BunProbeStream]::new($bytes); $cancellation=[Threading.CancellationTokenSource]::new(); $cancellation.Cancel()
    $path=Join-Path $root 'cancelled-copy'
    try { $caught=Expect-Failure { Copy-BunStream $source $path 8 'unused cap' -Async -CancellationToken $cancellation.Token } }
    finally { $cancellation.Dispose() }
    if ($caught.Exception.GetBaseException() -isnot [OperationCanceledException] -or !$source.WasDisposed -or (Get-Item -LiteralPath $path).Length -ne 0) { throw 'Async cancellation or cleanup changed' }
    $passed.Add('async-cancellation-retained-input-closed')
    [ordered]@{ phase='offline Bun output streams only'; networkExecuted=$false; productExecuted=$false; windowsDiskOperations=$false; passed=@($passed) } | ConvertTo-Json -Depth 4
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
