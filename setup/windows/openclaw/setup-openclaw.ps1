[CmdletBinding()]
param(
    [string]$OpenClawBaseUrl = '',
    [string]$OpenClawPath = '',
    [string]$OpenClawProcessPattern = '*openclaw*',
    [string]$OpenClawProfileName = 'aihub',
    [ValidateSet('docker', 'adopt')]
    [string]$QdrantMode = 'docker',
    [string]$QdrantBaseUrl = 'http://127.0.0.1:6333',
    [string]$SearXngBaseUrl = '',
    [switch]$StartHub,
    [switch]$StartQdrant,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'

$sharedModulePath = Join-Path (Join-Path $PSScriptRoot '..\shared') 'Setup.Common.psm1'
Import-Module $sharedModulePath -Force

$projectRoot = Get-SetupProjectRoot -ScriptRoot $PSScriptRoot
$preflightScript = Join-Path $projectRoot 'setup\windows\shared\preflight.ps1'
$envMergeScript = Join-Path $projectRoot 'setup\windows\shared\env-merge.ps1'
$detectScript = Join-Path $projectRoot 'setup\windows\shared\detect.ps1'
$stackConfigPath = Join-Path $PSScriptRoot 'stack.json'
$composePath = Join-Path $PSScriptRoot 'docker-compose.yml'
$envPath = Join-Path $projectRoot '.env'
$distPath = Join-Path $projectRoot 'dist\index.js'
$nodeModulesPath = Join-Path $projectRoot 'node_modules'

function Get-ComponentResult {
    param(
        [Parameter(Mandatory)]
        [psobject[]]$Components,
        [Parameter(Mandatory)]
        [string]$Id
    )

    return @($Components | Where-Object { $_.id -eq $Id } | Select-Object -First 1)[0]
}

function Invoke-ComposeUp {
    param(
        [Parameter(Mandatory)]
        [string[]]$Services,
        [Parameter(Mandatory)]
        [string]$ComposeFile
    )

    $dockerState = Get-DockerState
    if (-not ($dockerState.Available -and $dockerState.DaemonRunning -and $dockerState.ComposeAvailable)) {
        throw 'Docker Compose is required to start bundled helper services.'
    }

    $arguments = @($dockerState.ComposeArgs + @('-f', $ComposeFile, 'up', '-d') + $Services)
    & $dockerState.ComposeCommand @arguments
    if ($LASTEXITCODE -ne 0) {
        throw ('Docker Compose failed for services: ' + ($Services -join ', '))
    }
}

function Get-DetectionSnapshot {
    $json = & $detectScript -StackConfigPath $stackConfigPath -OpenClawBaseUrl $OpenClawBaseUrl -OpenClawPath $OpenClawPath -OpenClawProcessPattern $OpenClawProcessPattern -QdrantBaseUrl $QdrantBaseUrl -SearXngBaseUrl $SearXngBaseUrl -AsJson
    if (-not $json) {
        throw 'Detection script returned no data.'
    }

    return $json | ConvertFrom-Json
}

function Get-OpenClawStateDir {
    param(
        [Parameter(Mandatory)]
        [string]$ProfileName
    )

    if ([string]::IsNullOrWhiteSpace($ProfileName) -or $ProfileName -eq 'default') {
        return Join-Path $env:USERPROFILE '.openclaw'
    }

    return Join-Path $env:USERPROFILE ('.openclaw-' + $ProfileName)
}

function Get-OpenClawGatewayPort {
    param(
        [Parameter(Mandatory)]
        [string]$ProfileName
    )

    if ($ProfileName -eq 'aihub') {
        return 18889
    }

    return 18789
}

function Get-OpenClawMdnsHostname {
    param(
        [Parameter(Mandatory)]
        [string]$ProfileName
    )

    $normalized = (($ProfileName -replace '[^A-Za-z0-9-]', '-') -replace '-{2,}', '-').Trim('-').ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($normalized)) {
        $normalized = 'profile'
    }

    return 'openclaw-' + $normalized
}

function Ensure-OpenClawConvenienceScripts {
    param(
        [Parameter(Mandatory)]
        [string]$ProfileName
    )

    $stateDir = Get-OpenClawStateDir -ProfileName $ProfileName
    $gatewayPort = Get-OpenClawGatewayPort -ProfileName $ProfileName
    $mdnsHostname = Get-OpenClawMdnsHostname -ProfileName $ProfileName
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }

    $stateDirName = Split-Path $stateDir -Leaf
    $gatewayCmd = '%USERPROFILE%\' + $stateDirName + '\gateway.cmd'
    $startPath = Join-Path $stateDir 'start.bat'
    $stopPath = Join-Path $stateDir 'stop.bat'
    $helperPath = Join-Path $stateDir 'profile-tools.ps1'
    $helperPathForBatch = '%USERPROFILE%\' + $stateDirName + '\profile-tools.ps1'
    $configPath = Join-Path $stateDir 'openclaw.json'

    $helperLines = @(
        '[CmdletBinding()]',
        'param(',
        '    [Parameter(Mandatory)]',
        '    [ValidateSet("prepare-start","cleanup-after-stop","ensure-profile")]',
        '    [string]$Action',
        ')',
        '',
        '$ErrorActionPreference = "Stop"',
        '',
        ('$ProfileName = "{0}"' -f $ProfileName),
        ('$StateDir = "{0}"' -f $stateDir.Replace('\', '\\')),
        ('$ConfigPath = "{0}"' -f $configPath.Replace('\', '\\')),
        ('$GatewayCmdPath = "{0}"' -f (Join-Path $stateDir 'gateway.cmd').Replace('\', '\\')),
        ('$GatewayPort = {0}' -f $gatewayPort),
        ('$MdnsHostname = "{0}"' -f $mdnsHostname),
        '',
        'function Get-GatewayProcesses {',
        '    $pattern = [regex]::Escape("openclaw\dist\index.js gateway --port " + $GatewayPort)',
        '    $processes = Get-CimInstance Win32_Process -Filter "Name = ''node.exe''" -ErrorAction SilentlyContinue',
        '    if (-not $processes) {',
        '        return @()',
        '    }',
        '',
        '    return @($processes | Where-Object {',
        '        $_.CommandLine -and $_.CommandLine -match $pattern',
        '    })',
        '}',
        '',
        'function Stop-GatewayProcesses {',
        '    $targets = Get-GatewayProcesses',
        '    foreach ($target in $targets) {',
        '        try {',
        '            Stop-Process -Id $target.ProcessId -ErrorAction Stop',
        '        } catch {',
        '        }',
        '    }',
        '',
        '    Start-Sleep -Milliseconds 750',
        '',
        '    foreach ($target in (Get-GatewayProcesses)) {',
        '        try {',
        '            Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop',
        '        } catch {',
        '        }',
        '    }',
        '}',
        '',
        'function Ensure-ProfileConfig {',
        '    if (-not (Test-Path $ConfigPath)) {',
        '        return',
        '    }',
        '',
        '    $content = Get-Content -Path $ConfigPath -Raw -ErrorAction Stop',
        '    if ([string]::IsNullOrWhiteSpace($content)) {',
        '        return',
        '    }',
        '',
        '    $config = $content | ConvertFrom-Json -ErrorAction Stop',
        '    if (-not $config.discovery) {',
        '        $config | Add-Member -NotePropertyName discovery -NotePropertyValue ([pscustomobject]@{})',
        '    }',
        '    if (-not $config.discovery.mdns) {',
        '        $config.discovery | Add-Member -NotePropertyName mdns -NotePropertyValue ([pscustomobject]@{})',
        '    }',
        '    if (-not $config.discovery.mdns.PSObject.Properties["mode"]) {',
        '        $config.discovery.mdns | Add-Member -NotePropertyName mode -NotePropertyValue "off"',
        '    } else {',
        '        $config.discovery.mdns.mode = "off"',
        '    }',
        '',
        '    $json = $config | ConvertTo-Json -Depth 100',
        '    $json + [Environment]::NewLine | Set-Content -Path $ConfigPath -Encoding utf8',
        '}',
        '',
        'function Ensure-GatewayWrapper {',
        '    if (-not (Test-Path $GatewayCmdPath)) {',
        '        return',
        '    }',
        '',
        '    $lines = Get-Content -Path $GatewayCmdPath -ErrorAction Stop',
        '    $desiredLine = ''set "OPENCLAW_MDNS_HOSTNAME='' + $MdnsHostname + ''"''',
        '    $existingIndex = -1',
        '    for ($i = 0; $i -lt $lines.Count; $i++) {',
        '        if ($lines[$i] -match ''^set "OPENCLAW_MDNS_HOSTNAME='') {',
        '            $existingIndex = $i',
        '            break',
        '        }',
        '    }',
        '',
        '    if ($existingIndex -ge 0) {',
        '        if ($lines[$existingIndex] -ne $desiredLine) {',
        '            $lines[$existingIndex] = $desiredLine',
        '            $lines | Set-Content -Path $GatewayCmdPath -Encoding ASCII',
        '        }',
        '        return',
        '    }',
        '',
        '    $insertIndex = -1',
        '    for ($i = 0; $i -lt $lines.Count; $i++) {',
        '        if ($lines[$i] -match ''^set "OPENCLAW_GATEWAY_PORT='') {',
        '            $insertIndex = $i + 1',
        '            break',
        '        }',
        '    }',
        '',
        '    if ($insertIndex -lt 0) {',
        '        $lines += $desiredLine',
        '    } else {',
        '        $before = @()',
        '        if ($insertIndex -gt 0) {',
        '            $before = $lines[0..($insertIndex - 1)]',
        '        }',
        '        $after = @()',
        '        if ($insertIndex -lt $lines.Count) {',
        '            $after = $lines[$insertIndex..($lines.Count - 1)]',
        '        }',
        '        $lines = @($before + $desiredLine + $after)',
        '    }',
        '',
        '    $lines | Set-Content -Path $GatewayCmdPath -Encoding ASCII',
        '}',
        '',
        'switch ($Action) {',
        '    "prepare-start" {',
        '        Ensure-ProfileConfig',
        '        Ensure-GatewayWrapper',
        '        Stop-GatewayProcesses',
        '    }',
        '    "cleanup-after-stop" {',
        '        Ensure-ProfileConfig',
        '        Ensure-GatewayWrapper',
        '        Stop-GatewayProcesses',
        '    }',
        '    "ensure-profile" {',
        '        Ensure-ProfileConfig',
        '        Ensure-GatewayWrapper',
        '    }',
        '}'
    )

    $startLines = @(
        '@echo off',
        'setlocal EnableExtensions',
        '',
        ("set `"PROFILE=$ProfileName`""),
        ("set `"GATEWAY_CMD=$gatewayCmd`""),
        ("set `"PROFILE_HELPER=$helperPathForBatch`""),
        '',
        'where openclaw.cmd >nul 2>&1',
        'if errorlevel 1 (',
        '    echo ERROR: openclaw.cmd not found on PATH.',
        '    exit /b 1',
        ')',
        '',
        'if not exist "%GATEWAY_CMD%" (',
        '    echo Installing OpenClaw gateway service for profile %PROFILE%...',
        '    call openclaw.cmd --profile %PROFILE% gateway install --runtime node',
        '    if errorlevel 1 (',
        '        echo ERROR: failed to install the OpenClaw gateway service.',
        '        exit /b 1',
        '    )',
        ')',
        '',
        'if not exist "%PROFILE_HELPER%" (',
        '    echo ERROR: OpenClaw profile helper missing: %PROFILE_HELPER%',
        '    exit /b 1',
        ')',
        '',
        'echo Preparing OpenClaw profile %PROFILE%...',
        'call openclaw.cmd --profile %PROFILE% gateway stop >nul 2>&1',
        'powershell -NoProfile -ExecutionPolicy Bypass -File "%PROFILE_HELPER%" -Action prepare-start',
        'if errorlevel 1 (',
        '    echo ERROR: failed to prepare the OpenClaw profile.',
        '    exit /b 1',
        ')',
        '',
        'echo Starting OpenClaw profile %PROFILE%...',
        'call openclaw.cmd --profile %PROFILE% gateway start >nul 2>&1',
        '',
        'for /L %%I in (1,1,20) do (',
        '    call openclaw.cmd --profile %PROFILE% gateway health >nul 2>&1',
        '    if not errorlevel 1 goto ready',
        '    timeout /t 1 /nobreak >nul',
        ')',
        '',
        'echo ERROR: OpenClaw gateway did not become healthy in time.',
        'exit /b 1',
        '',
        ':ready',
        'for /f "tokens=1,* delims=:" %%A in (''openclaw.cmd --profile %PROFILE% dashboard --no-open ^| findstr /C:"Dashboard URL:"'') do set "DASHBOARD_URL=%%B"',
        'echo OpenClaw profile %PROFILE% is ready.',
        'if defined DASHBOARD_URL echo Dashboard:%DASHBOARD_URL%',
        'start "" cmd.exe /d /c openclaw.cmd --profile %PROFILE% dashboard',
        'exit /b 0'
    )

    $stopLines = @(
        '@echo off',
        'setlocal EnableExtensions',
        '',
        ("set `"PROFILE=$ProfileName`""),
        ("set `"PROFILE_HELPER=$helperPathForBatch`""),
        '',
        'where openclaw.cmd >nul 2>&1',
        'if errorlevel 1 (',
        '    echo ERROR: openclaw.cmd not found on PATH.',
        '    exit /b 1',
        ')',
        '',
        'echo Stopping OpenClaw profile %PROFILE%...',
        'call openclaw.cmd --profile %PROFILE% gateway stop >nul 2>&1',
        '',
        'if exist "%PROFILE_HELPER%" (',
        '    powershell -NoProfile -ExecutionPolicy Bypass -File "%PROFILE_HELPER%" -Action cleanup-after-stop',
        ')',
        '',
        'for /L %%I in (1,1,15) do (',
        '    call openclaw.cmd --profile %PROFILE% gateway health >nul 2>&1',
        '    if errorlevel 1 goto stopped',
        '    timeout /t 1 /nobreak >nul',
        ')',
        '',
        'echo WARNING: gateway still appears to be running.',
        'echo Check: openclaw.cmd --profile %PROFILE% gateway status',
        'exit /b 1',
        '',
        ':stopped',
        'echo OpenClaw profile %PROFILE% stopped.',
        'exit /b 0'
    )

    Set-Content -Path $helperPath -Value $helperLines -Encoding ASCII
    Set-Content -Path $startPath -Value $startLines -Encoding ASCII
    Set-Content -Path $stopPath -Value $stopLines -Encoding ASCII

    return [pscustomobject]@{
        profileName = $ProfileName
        stateDir = $stateDir
        helperScriptPath = $helperPath
        startScriptPath = $startPath
        stopScriptPath = $stopPath
    }
}

$preflightJson = & $preflightScript -RequireDocker:($QdrantMode -eq 'docker') -AsJson
$preflightExitCode = $LASTEXITCODE
$preflight = $preflightJson | ConvertFrom-Json
if ($preflightExitCode -ne 0) {
    throw ($preflight.fatalErrors -join ' ')
}

$envMerge = (& $envMergeScript -AsJson) | ConvertFrom-Json
$actions = @()
if ($envMerge.Created) {
    $actions += 'Created .env from .env.example.'
} elseif ($envMerge.AddedKeys.Count -gt 0) {
    $actions += ('Merged missing .env keys: ' + ($envMerge.AddedKeys -join ', '))
}

$convenienceScripts = Ensure-OpenClawConvenienceScripts -ProfileName $OpenClawProfileName
$actions += ('Generated OpenClaw profile helper: ' + $convenienceScripts.helperScriptPath)
$actions += ('Generated OpenClaw convenience launchers: ' + $convenienceScripts.startScriptPath + ' and ' + $convenienceScripts.stopScriptPath)

if (-not $AsJson) {
    Write-SetupSection -Title 'OpenClaw stack setup'
}

if (-not (Test-Path $nodeModulesPath)) {
    Write-Host 'Installing npm dependencies for AI Access Hub...'
    Push-Location $projectRoot
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            throw 'npm install failed.'
        }
    } finally {
        Pop-Location
    }
    $actions += 'Installed npm dependencies.'
} else {
    $actions += 'Reused existing node_modules.'
}

if (-not (Test-Path $distPath)) {
    Write-Host 'Building AI Access Hub...'
    Push-Location $projectRoot
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run build failed.'
        }
    } finally {
        Pop-Location
    }
    $actions += 'Built dist/index.js.'
} else {
    $actions += 'Reused existing dist/index.js.'
}

$detection = Get-DetectionSnapshot

if ($QdrantMode -eq 'docker') {
    $qdrant = Get-ComponentResult -Components $detection.components -Id 'qdrant'
    if ($StartQdrant -and -not $qdrant.healthy) {
        Write-Host 'Starting bundled Qdrant container...'
        Invoke-ComposeUp -Services @('qdrant') -ComposeFile $composePath
        $actions += 'Started bundled Qdrant container.'

        $healthy = $false
        for ($attempt = 0; $attempt -lt 15; $attempt++) {
            $healthResult = Test-HttpEndpoint -Url ($QdrantBaseUrl.TrimEnd('/') + '/healthz')
            if ($healthResult.Success) {
                $healthy = $true
                break
            }

            Start-Sleep -Seconds 1
        }

        if (-not $healthy) {
            Write-Host 'warning: Qdrant container started but is not healthy yet.'
        }

        $detection = Get-DetectionSnapshot
    }
}

$hub = Get-ComponentResult -Components $detection.components -Id 'hub'
if ($StartHub -and -not $hub.healthy) {
    Write-Host 'Starting AI Access Hub...'
    & (Join-Path $projectRoot 'scripts\start.ps1')
    if ($LASTEXITCODE -ne 0) {
        throw 'AI Access Hub failed to start.'
    }
    $actions += 'Started AI Access Hub.'
    $detection = Get-DetectionSnapshot
    $hub = Get-ComponentResult -Components $detection.components -Id 'hub'
}

$hubPort = [int](Get-EnvValue -Key 'HUB_PORT' -FilePath $envPath -Default '3000')
$hubBaseUrl = 'http://127.0.0.1:' + $hubPort + '/v1'
$dashboardUrl = 'http://127.0.0.1:' + $hubPort + '/dashboard'

$openClaw = Get-ComponentResult -Components $detection.components -Id 'openclaw'
$qdrant = Get-ComponentResult -Components $detection.components -Id 'qdrant'
$searxng = Get-ComponentResult -Components $detection.components -Id 'searxng'

$nextSteps = @()
if ($envMerge.Created) {
    $nextSteps += 'Fill provider API keys and strong secrets into .env before treating the hub as production-ready.'
}
if (-not $openClaw.detected) {
    $nextSteps += 'Rerun setup-openclaw.bat with -OpenClawBaseUrl http://127.0.0.1:<port> or -OpenClawPath C:\path\to\OpenClaw so the package can adopt your existing OpenClaw install.'
} elseif (-not $openClaw.running) {
    $nextSteps += 'OpenClaw is installed but not running. Start it, then rerun setup-openclaw.bat with -OpenClawBaseUrl http://127.0.0.1:<port> if it exposes an HTTP endpoint.'
} elseif (-not $openClaw.healthy -and -not $OpenClawBaseUrl) {
    $nextSteps += 'OpenClaw is running but no health URL was provided. Rerun setup-openclaw.bat with -OpenClawBaseUrl http://127.0.0.1:<port> for stronger verification.'
}
if ($QdrantMode -eq 'docker' -and -not $qdrant.healthy) {
    $nextSteps += 'Run setup-openclaw.bat -StartQdrant to launch the bundled Qdrant container if you want the local Docker path.'
}
if ($QdrantMode -eq 'adopt' -and -not $qdrant.healthy) {
    $nextSteps += 'Confirm the adopted Qdrant base URL is reachable: ' + $QdrantBaseUrl
}
if (-not $hub.healthy) {
    $nextSteps += 'Run setup-openclaw.bat -StartHub or start.bat to bring the hub online before wiring OpenClaw to it.'
}
$nextSteps += 'Use ' + $convenienceScripts.startScriptPath + ' and ' + $convenienceScripts.stopScriptPath + ' for clean OpenClaw start and stop on Windows.'
$nextSteps += 'In OpenClaw, set the OpenAI-compatible base URL to ' + $hubBaseUrl
$nextSteps += 'Use a hub client token for OpenClaw traffic. Do not use the admin token.'
$nextSteps += 'Recommended model aliases for OpenClaw: strong-code, strong-free, fast-free.'
if (-not $searxng.healthy) {
    $nextSteps += 'SearXNG is optional in this first implementation. Adopt an existing SearXNG endpoint later with -SearXngBaseUrl if you want search augmentation.'
}

$summary = [pscustomobject]@{
    stackName = 'OpenClaw + AI Access Hub'
    actions = $actions
    openClawProfile = [pscustomobject]@{
        profileName = $convenienceScripts.profileName
        stateDir = $convenienceScripts.stateDir
        helperScriptPath = $convenienceScripts.helperScriptPath
        startScriptPath = $convenienceScripts.startScriptPath
        stopScriptPath = $convenienceScripts.stopScriptPath
    }
    env = [pscustomobject]@{
        created = [bool]$envMerge.Created
        backupPath = $envMerge.BackupPath
        addedKeys = @($envMerge.AddedKeys)
        targetPath = $envMerge.TargetPath
    }
    hubBaseUrl = $hubBaseUrl
    dashboardUrl = $dashboardUrl
    qdrantBaseUrl = $QdrantBaseUrl
    searxngBaseUrl = $SearXngBaseUrl
    components = $detection.components
    nextSteps = $nextSteps
}

if ($AsJson) {
    $summary | ConvertTo-Json -Depth 10
    exit 0
}

if ($summary.actions.Count -gt 0) {
    Write-SetupSection -Title 'Actions'
    foreach ($action in $summary.actions) {
        Write-Host ('- ' + $action)
    }
}

Write-SetupReport -Summary $summary
