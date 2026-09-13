# Opt-in Windows integration test. No upstream model requests or provider edits.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$testState = Join-Path $root ('.test-managed-task-' + [Guid]::NewGuid().ToString('N'))
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
function Read-Runtime { Get-Content -LiteralPath (Join-Path $testState 'runtime.json') -Raw | ConvertFrom-Json }
try {
    & (Join-Path $root 'scripts\Install-BridgeTask.ps1') -StateDir $testState -Port $port -NoAutoStart
    $metadata = Get-Content -LiteralPath (Join-Path $testState 'bridge-task.json') -Raw | ConvertFrom-Json
    $task = Get-ScheduledTask -TaskName $metadata.taskName
    if (@($task.Triggers | Where-Object { $null -ne $_ }).Count -ne 0) { throw 'On-demand install unexpectedly added a trigger' }
    $before = Read-Runtime
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($before.pid)"
    if (!$process.CommandLine.Contains($testState)) { throw 'Runtime process does not belong to this test' }
    # A no-trigger task stays on-demand when manually started without an
    # explicit opt-in. Then upgrade it explicitly to autostart for recovery.
    & (Join-Path $root 'scripts\Start-Bridge.ps1') -StateDir $testState
    if (@((Get-ScheduledTask -TaskName $metadata.taskName).Triggers | Where-Object { $null -ne $_ }).Count -ne 0) { throw 'Manual start changed an existing on-demand task to autostart' }
    & (Join-Path $root 'scripts\Install-BridgeTask.ps1') -StateDir $testState -Port $port -NoAutoStart:$false
    $task = Get-ScheduledTask -TaskName $metadata.taskName
    if (@($task.Triggers | Where-Object { $null -ne $_ }).Count -lt 2) { throw 'Autostart task needs logon and periodic triggers' }
    [xml]$xml = Export-ScheduledTask -TaskName $metadata.taskName
    $repetition = $xml.SelectSingleNode("//*[local-name()='Triggers']/*[local-name()='TimeTrigger']/*[local-name()='Repetition']")
    if (!$repetition -or $repetition.Interval -ne 'PT1M') { throw 'Periodic trigger interval is not one minute' }
    if ($repetition.Duration) { throw 'Periodic trigger has a finite duration' }
    $timeTrigger = @($task.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT1M' })[0]
    if ($timeTrigger.Repetition.StopAtDurationEnd) { throw 'Periodic trigger must not stop at its duration boundary' }
    $firstPid = [int](Read-Runtime).pid
    # Stop the whole Task: no Start-ScheduledTask call follows. The periodic
    # trigger must create a new healthy task-owned runtime in <= 80 seconds.
    Stop-ScheduledTask -TaskName $metadata.taskName
    $recovered = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(80)
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 2
        try {
            $after = Read-Runtime
            if ([int]$after.pid -eq $firstPid) { continue }
            $state = Get-Content -LiteralPath (Join-Path $testState 'bridge.json') -Raw | ConvertFrom-Json
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -Headers @{Authorization = "Bearer $($state.token)"} -TimeoutSec 2
            if ($health.service -eq 'opencodex-workbuddy-connect') { $recovered = $true; break }
        } catch {}
    }
    if (!$recovered) { throw 'Bridge did not recover automatically within 80 seconds after Scheduled Task stop' }
    Write-Output 'PASS: periodic managed-task re-entry restored a stopped bridge.'
} finally {
    & (Join-Path $root 'scripts\Remove-BridgeTask.ps1') -StateDir $testState
    if ($metadata -and (Get-ScheduledTask -TaskName $metadata.taskName -ErrorAction SilentlyContinue)) { throw 'Test task was not removed' }
}
