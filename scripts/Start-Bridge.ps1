param(
    [string]$StateDir = (Join-Path $env:USERPROFILE '.opencodex\workbuddy-connect'),
    [ValidateRange(1024, 65535)][int]$Port = 10108
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$bridgeEntry = Join-Path $sourceRoot 'src\cli.ts'
$node = Get-Command node.exe -ErrorAction Stop
$portWasSpecified = $PSBoundParameters.ContainsKey('Port')
$nodeMajor = [int]((& $node.Source --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node.js 24 or newer is required; found $nodeMajor." }
$resolvedState = [IO.Path]::GetFullPath($StateDir)
New-Item -ItemType Directory -Force -Path $resolvedState | Out-Null
$bridgeStatePath = Join-Path $resolvedState 'bridge.json'
$runtimePath = Join-Path $resolvedState 'runtime.json'
function Test-OwnBridgeProcess([int]$ProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    return $null -ne $process -and $process.CommandLine -and $process.CommandLine.Contains($bridgeEntry) -and $process.CommandLine.Contains($resolvedState)
}
function Test-ConnectionFailure([Exception]$Exception) {
    for ($current = $Exception; $null -ne $current; $current = $current.InnerException) {
        $typeName = $current.GetType().FullName
        if ($typeName -eq 'System.Net.WebException') {
            return @('ConnectFailure', 'Timeout', 'NameResolutionFailure', 'ConnectionClosed', 'ReceiveFailure', 'SendFailure') -contains [string]$current.Status
        }
        if (@('System.Net.Sockets.SocketException', 'System.TimeoutException', 'System.Threading.Tasks.TaskCanceledException') -contains $typeName) { return $true }
        # Windows PowerShell 5.1 does not always load System.Net.Http.
        if ($typeName -eq 'System.Net.Http.HttpRequestException' -and !$current.StatusCode) { return $true }
    }
    return $false
}
if (Test-Path -LiteralPath $bridgeStatePath) {
    $existing = Get-Content -LiteralPath $bridgeStatePath -Raw | ConvertFrom-Json
    if ($portWasSpecified -and $existing.port -ne $Port) { throw "This bridge state is configured for port $($existing.port), not $Port. Use its existing port or a different state directory." }
    $Port = $existing.port
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($existing.port)/healthz" -Headers @{Authorization = "Bearer $($existing.token)"} -TimeoutSec 3
        if ($health.service -eq 'opencodex-workbuddy-connect') {
            if (!(Test-Path -LiteralPath $runtimePath)) { throw 'A bridge answers this state token but its runtime identity is missing; it was not adopted.' }
            $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
            if ($runtime.pid -and (Test-OwnBridgeProcess -ProcessId $runtime.pid)) { Write-Output 'WorkBuddy bridge is already running.'; return }
            throw 'A bridge answers this state token but is not this installation; it was not adopted.'
        }
        throw "Port $($existing.port) is occupied by another service."
    } catch {
        if (!(Test-ConnectionFailure $_.Exception)) { throw }
    }
}
$bridgeArgs = '"' + $bridgeEntry + '" serve --state-dir "' + $resolvedState + '" --port ' + $Port
$process = Start-Process -FilePath $node.Source -ArgumentList $bridgeArgs -WindowStyle Hidden -PassThru -WorkingDirectory $sourceRoot -RedirectStandardOutput (Join-Path $resolvedState 'bridge.log') -RedirectStandardError (Join-Path $resolvedState 'bridge.error.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    if ($process.HasExited) { throw 'WorkBuddy bridge exited during startup; check bridge.error.log in its state directory.' }
    if (!(Test-Path -LiteralPath $bridgeStatePath) -or !(Test-Path -LiteralPath $runtimePath)) { continue }
    $current = Get-Content -LiteralPath $bridgeStatePath -Raw | ConvertFrom-Json
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($current.port)/healthz" -Headers @{Authorization = "Bearer $($current.token)"} -TimeoutSec 2
        if ($health.service -eq 'opencodex-workbuddy-connect' -and $runtime.pid -eq $process.Id -and (Test-OwnBridgeProcess -ProcessId $process.Id)) {
            Write-Output "WorkBuddy bridge is ready on 127.0.0.1:$($current.port)."; return
        }
    } catch { }
}
Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
throw 'WorkBuddy bridge did not become ready with a verified runtime identity.'
