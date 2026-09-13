param(
    [Parameter(Mandatory = $true)][string]$StateDir,
    [ValidateRange(1024, 65535)][int]$Port = 10108,
    [string]$NodePath
)

# This script is the long-lived Scheduled Task action. Keep the Node process in
# the foreground: if it exits, Task Scheduler still owns this wrapper rather
# than an ephemeral parent shell that may disappear after installation.
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$bridgeEntry = Join-Path $sourceRoot 'src\cli.ts'
$resolvedState = [IO.Path]::GetFullPath($StateDir)
$logPath = Join-Path $resolvedState 'bridge-supervisor.log'

if (!(Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) { throw 'Bridge entrypoint is missing.' }
New-Item -ItemType Directory -Force -Path $resolvedState | Out-Null

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $NodePath = $nodeCommand.Source
}
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Configured Node.js executable does not exist.' }
$nodeMajor = [int]((& $NodePath --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node.js 24 or newer is required; found $nodeMajor." }

# Task Scheduler can stop the wrapper without stopping its native child.
# Reclaim only a runtime recorded by this installation whose owner is gone.
$runtimePath = Join-Path $resolvedState 'runtime.json'
if (Test-Path -LiteralPath $runtimePath) {
    $previousRuntime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if ($previousRuntime.pid) {
        $previousNode = Get-CimInstance Win32_Process -Filter "ProcessId = $($previousRuntime.pid)" -ErrorAction SilentlyContinue
        if ($previousNode -and $previousNode.CommandLine -and $previousNode.CommandLine.Contains($bridgeEntry) -and $previousNode.CommandLine.Contains($resolvedState)) {
            $previousOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($previousNode.ParentProcessId)" -ErrorAction SilentlyContinue
            $ownerAlive = $previousOwner -and $previousOwner.CommandLine -and $previousOwner.CommandLine.Contains($PSCommandPath) -and $previousOwner.CommandLine.Contains($resolvedState) -and ($previousOwner.CreationDate -le $previousNode.CreationDate)
            if ($ownerAlive) { throw 'Another supervisor already owns this bridge runtime.' }
            Stop-Process -Id ([int]$previousRuntime.pid) -ErrorAction Stop
            Wait-Process -Id ([int]$previousRuntime.pid) -Timeout 5 -ErrorAction SilentlyContinue
            Add-Content -LiteralPath $logPath -Value ("[{0:O}] reclaimed previous bridge child after supervisor exit" -f [DateTime]::UtcNow) -Encoding UTF8
        }
    }
}

$failureCount = 0
while ($true) {
    $startedAt = [DateTime]::UtcNow
    Add-Content -LiteralPath $logPath -Value ("[{0:O}] starting local bridge" -f [DateTime]::UtcNow) -Encoding UTF8
    # The bridge's normal stdout contains only its local service address and
    # PID. Credential files and tokens are never written to this task log.
    # In Windows PowerShell native stderr can create a non-terminating error;
    # it must not bypass this wrapper's retry path.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $NodePath $bridgeEntry 'serve' '--state-dir' $resolvedState '--port' $Port 2>&1 | ForEach-Object {
        Add-Content -LiteralPath $logPath -Value ([string]$_) -Encoding UTF8
    }
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedPreference
    if (([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 60) { $failureCount = 0 }
    $failureCount++
    $delay = if ($failureCount -ge 5) { 30 } else { 3 }
    Add-Content -LiteralPath $logPath -Value ("[{0:O}] bridge exited ({1}); retrying in {2}s" -f [DateTime]::UtcNow, $exitCode, $delay) -Encoding UTF8
    Start-Sleep -Seconds $delay
}
