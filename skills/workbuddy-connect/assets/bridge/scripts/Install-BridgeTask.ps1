param(
    [string]$StateDir = (Join-Path $env:USERPROFILE '.opencodex\workbuddy-connect'),
    [ValidateRange(1024, 65535)][int]$Port = 10108,
    [string]$NodePath,
    [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$runScript = Join-Path $PSScriptRoot 'Run-Bridge.ps1'
$bridgeEntry = Join-Path $sourceRoot 'src\cli.ts'
$resolvedState = [IO.Path]::GetFullPath($StateDir)
$stateFile = Join-Path $resolvedState 'bridge.json'
$runtimeFile = Join-Path $resolvedState 'runtime.json'
$taskMetadata = Join-Path $resolvedState 'bridge-task.json'

if (!(Test-Path -LiteralPath $runScript -PathType Leaf) -or !(Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) {
    throw 'Bridge task scripts or entrypoint are missing.'
}
if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$NodePath = [IO.Path]::GetFullPath($NodePath)
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Configured Node.js executable does not exist.' }
$nodeMajor = [int]((& $NodePath --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node.js 24 or newer is required; found $nodeMajor." }
New-Item -ItemType Directory -Force -Path $resolvedState | Out-Null

# An established state directory owns its selected port unless the caller
# explicitly supplies a replacement. This matches Start-Bridge.ps1 and avoids
# scheduling a permanent retry loop against a mismatched bridge state.
if (Test-Path -LiteralPath $stateFile) {
    try {
        $existingState = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if (!$existingState.port -or [int]$existingState.port -lt 1024 -or [int]$existingState.port -gt 65535) { throw 'invalid port' }
        if ($PSBoundParameters.ContainsKey('Port') -and [int]$existingState.port -ne $Port) {
            throw "This bridge state is configured for port $($existingState.port), not $Port. Use its existing port or a different state directory."
        }
        if (!$PSBoundParameters.ContainsKey('Port')) { $Port = [int]$existingState.port }
    } catch { throw 'Existing bridge state is invalid; no Scheduled Task was registered.' }
}

function Get-TaskName([string]$Path) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    $hex = -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
    return "OpenCodex WorkBuddy Bridge-$hex"
}

function Quote-TaskArgument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Get-OwnNodeProcess([int]$ProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process -or !$process.CommandLine -or !$process.CommandLine.Contains($bridgeEntry) -or !$process.CommandLine.Contains($resolvedState)) { return $null }
    return $process
}

function Test-TaskOwnedRuntime([int]$ProcessId) {
    $process = Get-OwnNodeProcess -ProcessId $ProcessId
    if ($null -eq $process) { return $false }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)" -ErrorAction SilentlyContinue
    return $null -ne $parent -and $parent.CommandLine -and $parent.CommandLine.Contains($runScript) -and $parent.CommandLine.Contains($resolvedState)
}

$taskName = Get-TaskName $resolvedState
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Quote-TaskArgument $runScript) + ' -StateDir ' + (Quote-TaskArgument $resolvedState) + ' -Port ' + $Port + ' -NodePath ' + (Quote-TaskArgument $NodePath)
$identity = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }

$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $sourceRoot
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -RunOnlyIfIdle:$false -DontStopOnIdleEnd

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    $existingAction = @($existing.Actions)[0]
    $sameAction = $null -ne $existingAction -and $existingAction.Execute -eq $powerShell -and $existingAction.Arguments -eq $arguments
    if (!$sameAction) {
        throw "A Scheduled Task named '$taskName' already exists with a different action. It was not changed."
    }
}

# A direct Start-Bridge.ps1 child is owned by this installation but not by the
# Scheduled Task. Migrate it only when no matching task is already running;
# otherwise it may be the task's own current child and must be left untouched.
if (Test-Path -LiteralPath $runtimeFile) {
    try {
        $priorRuntime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        $directProcess = if ($priorRuntime.pid) { Get-OwnNodeProcess -ProcessId ([int]$priorRuntime.pid) } else { $null }
        $taskRunning = $null -ne $existing -and [string]$existing.State -eq 'Running'
        if ($null -ne $directProcess -and !(Test-TaskOwnedRuntime -ProcessId ([int]$priorRuntime.pid)) -and !$taskRunning) {
            Stop-Process -Id ([int]$priorRuntime.pid) -ErrorAction Stop
            Start-Sleep -Milliseconds 300
        }
    } catch { throw "Existing bridge runtime could not be safely migrated: $($_.Exception.Message)" }
}

# `-NoAutoStart:$true` deliberately creates an on-demand task with no trigger.
# Autostart tasks re-enter every minute: IgnoreNew leaves a healthy wrapper
# alone and restarts one that was killed outside Task Scheduler.
$taskArguments = @{ Action = $action; Principal = $principal; Settings = $settings }
 $existingTriggers = if ($null -ne $existing) { @($existing.Triggers | Where-Object { $null -ne $_ }) } else { @() }
$keepOnDemand = ($PSBoundParameters.ContainsKey('NoAutoStart') -and $NoAutoStart) -or (
    !$PSBoundParameters.ContainsKey('NoAutoStart') -and $null -ne $existing -and $existingTriggers.Count -eq 0
)
if (!$keepOnDemand) {
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    # Omit duration so the schema serializes an indefinite PT1M repetition.
    $periodicTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $periodicTrigger.Repetition.StopAtDurationEnd = $false
    $taskArguments['Trigger'] = @($logonTrigger, $periodicTrigger)
}
$definition = New-ScheduledTask @taskArguments

# Registering an exact matching action is an in-place update of this task's
# trigger/settings, never an overwrite of a different task identity.
Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
$metadata = [ordered]@{
    version = 1; taskName = $taskName; stateDir = $resolvedState; runScript = $runScript
    nodePath = $NodePath; port = $Port; updatedAt = [DateTime]::UtcNow.ToString('O')
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath $taskMetadata -Encoding UTF8

Start-ScheduledTask -TaskName $taskName
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (!(Test-Path -LiteralPath $stateFile) -or !(Test-Path -LiteralPath $runtimeFile)) { continue }
    try {
        $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        if (!$state.token -or !$state.port -or !$runtime.pid -or !(Test-TaskOwnedRuntime -ProcessId ([int]$runtime.pid))) { continue }
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($state.port)/healthz" -Headers @{ Authorization = "Bearer $($state.token)" } -TimeoutSec 2
        if ($health.service -eq 'opencodex-workbuddy-connect') { $ready = $true; break }
    } catch { }
}
if (!$ready) { throw "Scheduled Task '$taskName' was registered but the bridge did not become healthy with this installation's runtime identity." }
Write-Output "WorkBuddy bridge task is running: $taskName"
