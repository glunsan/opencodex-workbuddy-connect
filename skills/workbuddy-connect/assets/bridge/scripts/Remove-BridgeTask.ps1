param(
    [string]$StateDir = (Join-Path $env:USERPROFILE '.opencodex\workbuddy-connect')
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$runScript = Join-Path $PSScriptRoot 'Run-Bridge.ps1'
$resolvedState = [IO.Path]::GetFullPath($StateDir)
$taskMetadata = Join-Path $resolvedState 'bridge-task.json'

function Get-TaskName([string]$Path) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    $hex = -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
    return "OpenCodex WorkBuddy Bridge-$hex"
}

function Quote-TaskArgument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

$taskName = Get-TaskName $resolvedState
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) { Write-Output 'No matching WorkBuddy bridge Scheduled Task was found.'; return }

$action = @($task.Actions)[0]
$expectedScript = Quote-TaskArgument $runScript
$expectedState = Quote-TaskArgument $resolvedState
if ($null -eq $action -or $action.Execute -ne $powerShell -or !$action.Arguments.Contains($expectedScript) -or !$action.Arguments.Contains($expectedState)) {
    throw "Scheduled Task '$taskName' does not belong to this bridge installation. It was not changed."
}

Disable-ScheduledTask -TaskName $taskName | Out-Null
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
$runtimePath = Join-Path $resolvedState 'runtime.json'
if (Test-Path -LiteralPath $runtimePath) {
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if ($runtime.pid) {
        $child = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)" -ErrorAction SilentlyContinue
        $entry = Join-Path $sourceRoot 'src\cli.ts'
        if ($child -and $child.CommandLine -and $child.CommandLine.Contains($entry) -and $child.CommandLine.Contains($resolvedState)) {
            Stop-Process -Id ([int]$runtime.pid) -ErrorAction Stop
            Wait-Process -Id ([int]$runtime.pid) -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
}
if (Test-Path -LiteralPath $taskMetadata) { Remove-Item -LiteralPath $taskMetadata -Force }
Write-Output "WorkBuddy bridge Scheduled Task removed: $taskName. Desktop login files were not changed."
