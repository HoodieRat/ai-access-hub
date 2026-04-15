[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string[]]$Urls,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'Setup.Common.psm1'
Import-Module $modulePath -Force

$results = @()
foreach ($url in $Urls) {
    if ([string]::IsNullOrWhiteSpace($url)) {
        continue
    }

    $results += Test-HttpEndpoint -Url $url
}

if ($AsJson) {
    $results | ConvertTo-Json -Depth 6
    exit 0
}

foreach ($result in $results) {
    $status = 'down'
    if ($result.Success) {
        $status = 'healthy'
    }

    Write-Host ('- ' + $result.Url + ': ' + $status)
}