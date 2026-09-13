param(
    [string]$StateDir = (Join-Path $env:USERPROFILE '.opencodex\workbuddy-connect'),
    [ValidateRange(1024, 65535)][int]$Port = 10108
)
$ErrorActionPreference = 'Stop'
$options = @{ StateDir = $StateDir }
if ($PSBoundParameters.ContainsKey('Port')) { $options.Port = $Port }
# Windows owns the supervisor, so returning from Codex cannot stop the provider.
& (Join-Path $PSScriptRoot 'Install-BridgeTask.ps1') @options
