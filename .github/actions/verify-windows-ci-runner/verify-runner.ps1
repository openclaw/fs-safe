function Assert-FsSafeWindowsCiRunner {
    param(
        [bool]$Windows,
        [string]$Architecture,
        [string]$RunnerOS,
        [int]$LogicalProcessors,
        [ValidateSet("4", "16")]
        [string]$MinimumLogicalProcessors = "16"
    )

    if (-not $Windows -or $Architecture -ne "X64" -or $RunnerOS -ne "Windows") {
        throw "Windows CI requires native Windows x64 and runner.os=Windows."
    }
    if ($LogicalProcessors -lt [int]$MinimumLogicalProcessors) {
        throw "Windows CI requires at least $MinimumLogicalProcessors logical processors; found $LogicalProcessors."
    }
}
