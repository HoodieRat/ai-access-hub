[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StackConfigPath,
    [string]$OpenClawBaseUrl = '',
    [string]$OpenClawPath = '',
    [string]$OpenClawProcessPattern = '*openclaw*',
    [string]$QdrantBaseUrl = 'http://127.0.0.1:6333',
    [string]$SearXngBaseUrl = '',
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot 'Setup.Common.psm1'
Import-Module $modulePath -Force

$projectRoot = Get-SetupProjectRoot -ScriptRoot $PSScriptRoot
$stackPath = [System.IO.Path]::GetFullPath($StackConfigPath)
$manifest = Get-Content $stackPath -Raw -ErrorAction Stop | ConvertFrom-Json
$envPath = Join-Path $projectRoot '.env'

$hubPort = Get-EnvValue -Key 'HUB_PORT' -FilePath $envPath -Default '3000'
$variables = @{
    PROJECT_ROOT = $projectRoot
    HUB_PORT = $hubPort
    OPENCLAW_BASE_URL = $OpenClawBaseUrl
    OPENCLAW_PATH = $OpenClawPath
    OPENCLAW_PROCESS_PATTERN = $OpenClawProcessPattern
    QDRANT_BASE_URL = $QdrantBaseUrl
    SEARXNG_BASE_URL = $SearXngBaseUrl
}

if ($OpenClawBaseUrl) {
    try {
        $variables.OPENCLAW_PORT = ([uri]$OpenClawBaseUrl).Port
    } catch {
        $variables.OPENCLAW_PORT = ''
    }
}

if ($QdrantBaseUrl) {
    try {
        $variables.QDRANT_PORT = ([uri]$QdrantBaseUrl).Port
    } catch {
        $variables.QDRANT_PORT = ''
    }
}

if ($SearXngBaseUrl) {
    try {
        $variables.SEARXNG_PORT = ([uri]$SearXngBaseUrl).Port
    } catch {
        $variables.SEARXNG_PORT = ''
    }
}

$result = [ordered]@{
    stackId = $manifest.id
    stackName = $manifest.displayName
    detectedAt = (Get-Date).ToString('s')
    projectRoot = $projectRoot
    components = @()
}

foreach ($component in $manifest.components) {
    $componentResult = [ordered]@{
        id = $component.id
        displayName = $component.displayName
        required = [bool]$component.required
        detected = $false
        installed = $false
        running = $false
        healthy = $false
        source = @()
        path = $null
        port = $null
        healthUrl = $null
        containerNames = @()
        issues = @()
    }

    $pathCandidates = @()
    foreach ($pathCandidate in @($component.pathCandidates)) {
        $expandedPath = Expand-SetupValue -Value ([string]$pathCandidate) -Variables $variables
        if (-not [string]::IsNullOrWhiteSpace($expandedPath)) {
            $pathCandidates += $expandedPath
        }
    }

    $existingPath = Find-ExistingPath -CandidatePaths $pathCandidates -ProjectRoot $projectRoot
    if ($existingPath) {
        $componentResult.detected = $true
        $componentResult.installed = $true
        $componentResult.path = $existingPath
        $componentResult.source += 'path'
    }

    $commandCandidates = @()
    foreach ($commandCandidate in @($component.commandCandidates)) {
        $expandedCommand = Expand-SetupValue -Value ([string]$commandCandidate) -Variables $variables
        if (-not [string]::IsNullOrWhiteSpace($expandedCommand)) {
            $commandCandidates += $expandedCommand
        }
    }

    if (-not $componentResult.path) {
        $existingCommand = Find-ExistingCommand -CandidateCommands $commandCandidates
        if ($existingCommand) {
            $componentResult.detected = $true
            $componentResult.installed = $true
            $componentResult.path = $existingCommand
            if ($componentResult.source -notcontains 'command') {
                $componentResult.source += 'command'
            }
        }
    }

    $processPatterns = @()
    foreach ($processPattern in @($component.processPatterns)) {
        $expandedPattern = Expand-SetupValue -Value ([string]$processPattern) -Variables $variables
        if (-not [string]::IsNullOrWhiteSpace($expandedPattern)) {
            $processPatterns += $expandedPattern
        }
    }

    $processMatches = Get-ProcessMatches -Patterns $processPatterns
    if ($processMatches.Count -gt 0) {
        $componentResult.detected = $true
        $componentResult.running = $true
        if ($componentResult.source -notcontains 'process') {
            $componentResult.source += 'process'
        }
    }

    foreach ($portCandidate in @($component.ports)) {
        $expandedPort = Expand-SetupValue -Value ([string]$portCandidate) -Variables $variables
        if ([string]::IsNullOrWhiteSpace($expandedPort)) {
            continue
        }

        $portNumber = 0
        if ([int]::TryParse($expandedPort, [ref]$portNumber) -and (Test-Port -Port $portNumber)) {
            $componentResult.detected = $true
            $componentResult.installed = $true
            $componentResult.running = $true
            if (-not $componentResult.port) {
                $componentResult.port = $portNumber
            }
            if ($componentResult.source -notcontains 'port') {
                $componentResult.source += 'port'
            }
            break
        }
    }

    foreach ($healthTemplate in @($component.healthUrls)) {
        $healthUrl = Expand-SetupValue -Value ([string]$healthTemplate) -Variables $variables
        if ([string]::IsNullOrWhiteSpace($healthUrl) -or $healthUrl -notmatch '^https?://') {
            continue
        }

        $healthResult = Test-HttpEndpoint -Url $healthUrl
        if ($healthResult.Success) {
            $componentResult.detected = $true
            $componentResult.installed = $true
            $componentResult.running = $true
            $componentResult.healthy = $true
            $componentResult.healthUrl = $healthResult.Url
            if ($componentResult.source -notcontains 'health') {
                $componentResult.source += 'health'
            }
            break
        }
    }

    $containerNames = @()
    foreach ($containerName in @($component.dockerContainers)) {
        $expandedContainerName = Expand-SetupValue -Value ([string]$containerName) -Variables $variables
        if (-not [string]::IsNullOrWhiteSpace($expandedContainerName)) {
            $containerNames += $expandedContainerName
        }
    }

    $containerMatches = Get-DockerContainerMatches -Names $containerNames
    if ($containerMatches.Count -gt 0) {
        $componentResult.detected = $true
        $componentResult.installed = $true
        $componentResult.containerNames = @($containerMatches.Name)
        if (@($containerMatches | Where-Object { $_.State -eq 'running' }).Count -gt 0) {
            $componentResult.running = $true
        }
        if ($componentResult.source -notcontains 'docker') {
            $componentResult.source += 'docker'
        }
    }

    if (-not $componentResult.detected) {
        $componentResult.issues += 'Not detected.'
    } elseif ($componentResult.required -and -not $componentResult.healthy -and -not $componentResult.running) {
        $componentResult.issues += 'Detected but not running.'
    }

    $result.components += [pscustomobject]$componentResult
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 10
    exit 0
}

$summary = [pscustomobject]@{
    stackName = $result.stackName
    components = $result.components
    nextSteps = @()
}
Write-SetupReport -Summary $summary