param(
    [string]$PromptFile = ".\rpg-master-prompt.txt",
    [int]$ContinueCount = 20,
    [string]$LogFile = ".\hermes-rpg-afk.log",
    [ValidateSet("rpg", "caveman")]
    [string]$Preset = "rpg"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PromptFile)) {
    Write-Error "Prompt file not found: $PromptFile"
}

$runner = Join-Path $PSScriptRoot "scripts\hermes-afk-runner.cjs"
if (-not (Test-Path $runner)) {
    Write-Error "Runner not found: $runner"
}

if ($Preset -eq "caveman" -and $LogFile -eq ".\hermes-rpg-afk.log") {
    $LogFile = ".\hermes-caveman-afk.log"
}

node $runner --preset $Preset --prompt-file $PromptFile --max-continues $ContinueCount --log-file $LogFile
Write-Host "Done. Output saved to $LogFile"
