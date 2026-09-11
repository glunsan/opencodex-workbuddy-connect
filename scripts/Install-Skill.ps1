param([string]$SkillHome)
$ErrorActionPreference = 'Stop'
if (!$SkillHome) {
    $codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $SkillHome = Join-Path $codexRoot 'skills'
}
$sourceRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $sourceRoot 'skills\workbuddy-connect'
if (!(Test-Path -LiteralPath (Join-Path $source 'SKILL.md'))) { throw 'Skill entrypoint is missing; download the complete package.' }
if (!(Test-Path -LiteralPath (Join-Path $source 'assets\bridge\src\cli.ts'))) { throw 'Bundled bridge is missing; download the complete package.' }
$target = Join-Path ([IO.Path]::GetFullPath($SkillHome)) 'workbuddy-connect'
if (Test-Path -LiteralPath $target) { throw "Skill already exists at $target. Review it before replacing it; no files were changed." }
New-Item -ItemType Directory -Force -Path $SkillHome | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse
Write-Output "Skill installed at $target"
Write-Output 'Reopen Codex and ask it to use $workbuddy-connect to connect your local WorkBuddy.'
Write-Output 'Only the skill was installed. No model provider or desktop login was changed.'
