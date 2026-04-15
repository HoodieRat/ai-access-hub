[CmdletBinding()]
param(
    [string]$TemplatePath,
    [string]$TargetPath,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'Setup.Common.psm1'
Import-Module $modulePath -Force

$projectRoot = Get-SetupProjectRoot -ScriptRoot $PSScriptRoot
if (-not $TemplatePath) {
    $TemplatePath = Join-Path $projectRoot '.env.example'
}
if (-not $TargetPath) {
    $TargetPath = Join-Path $projectRoot '.env'
}

$result = Merge-EnvTemplate -TemplatePath $TemplatePath -TargetPath $TargetPath

if ($AsJson) {
    $result | ConvertTo-Json -Depth 6
    exit 0
}

if ($result.Created) {
    Write-Host ('.env created from template: ' + $result.TargetPath)
} elseif ($result.AddedKeys.Count -gt 0) {
    Write-Host ('Merged missing env keys into ' + $result.TargetPath)
    Write-Host ('Backup: ' + $result.BackupPath)
    Write-Host ('Added keys: ' + ($result.AddedKeys -join ', '))
} else {
    Write-Host ('.env already contains all template keys: ' + $result.TargetPath)
}