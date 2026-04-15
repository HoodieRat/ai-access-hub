[CmdletBinding()]
param(
    [string]$Json
)

$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'Setup.Common.psm1'
Import-Module $modulePath -Force

if (-not $Json) {
    $Json = [Console]::In.ReadToEnd()
}

if (-not $Json) {
    throw 'Provide a JSON setup summary either through -Json or stdin.'
}

$summary = $Json | ConvertFrom-Json
Write-SetupReport -Summary $summary