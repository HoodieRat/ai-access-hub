[CmdletBinding()]
param(
    [switch]$RequireDocker,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'Setup.Common.psm1'
Import-Module $modulePath -Force

$projectRoot = Get-SetupProjectRoot -ScriptRoot $PSScriptRoot
$dockerState = Get-DockerState

$result = [ordered]@{
    projectRoot = $projectRoot
    node = [ordered]@{
        available = $false
        version = $null
        major = $null
    }
    npm = [ordered]@{
        available = $false
        version = $null
    }
    docker = [ordered]@{
        available = $dockerState.Available
        daemonRunning = $dockerState.DaemonRunning
        composeAvailable = $dockerState.ComposeAvailable
        clientVersion = $dockerState.ClientVersion
    }
    warnings = @()
    fatalErrors = @()
}

if (Test-CommandAvailable -Name 'node') {
    $result.node.available = $true
    $nodeVersion = (& node --version | Select-Object -First 1)
    $result.node.version = $nodeVersion
    $result.node.major = [int]$nodeVersion.TrimStart('v').Split('.')[0]
    if ($result.node.major -lt 18) {
        $result.fatalErrors += 'Node.js 18+ is required.'
    }
} else {
    $result.fatalErrors += 'node.exe not found. Install Node.js 18+ first.'
}

if (Test-CommandAvailable -Name 'npm') {
    $result.npm.available = $true
    $result.npm.version = (& npm --version | Select-Object -First 1)
} else {
    $result.fatalErrors += 'npm not found. Install Node.js with npm first.'
}

if ($RequireDocker) {
    if (-not $dockerState.Available) {
        $result.fatalErrors += 'Docker Desktop is required for this setup package.'
    } elseif (-not $dockerState.DaemonRunning) {
        $result.fatalErrors += 'Docker Desktop is installed but the Docker daemon is not running.'
    } elseif (-not $dockerState.ComposeAvailable) {
        $result.fatalErrors += 'Docker Compose support is required but was not detected.'
    }
} elseif ($dockerState.Available -and -not $dockerState.DaemonRunning) {
    $result.warnings += 'Docker Desktop is installed but not running. Docker-managed helper services will stay unavailable.'
}

$exitCode = 0
if ($result.fatalErrors.Count -gt 0) {
    $exitCode = 1
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 8
    exit $exitCode
}

Write-Host 'Windows setup preflight'
Write-Host ('- Project root: ' + $result.projectRoot)
Write-Host ('- Node: ' + ($(if ($result.node.available) { $result.node.version } else { 'missing' })))
Write-Host ('- npm: ' + ($(if ($result.npm.available) { $result.npm.version } else { 'missing' })))
Write-Host ('- Docker: ' + ($(if ($result.docker.available) { 'installed' } else { 'missing' })))

foreach ($warning in $result.warnings) {
    Write-Host ('warning: ' + $warning)
}

foreach ($errorMessage in $result.fatalErrors) {
    Write-Host ('error: ' + $errorMessage)
}

exit $exitCode