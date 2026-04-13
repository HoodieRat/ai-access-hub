$ErrorActionPreference = 'Stop'

function Get-EnvValue {
    param(
        [string]$Key,
        [string]$FilePath,
        [string]$Default = ''
    )

    $line = Get-Content $FilePath -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ('^' + [regex]::Escape($Key) + '=') -and -not $_.StartsWith('#') } |
        Select-Object -First 1

    if ($line) {
        return ($line -replace ('^' + [regex]::Escape($Key) + '='))
    }

    return $Default
}

function Resolve-ProjectPath {
    param(
        [string]$ProjectRoot,
        [string]$PathValue
    )

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return $PathValue
    }

    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $PathValue))
}

function Test-Port {
    param([int]$Port)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $null = $client.ConnectAsync('127.0.0.1', $Port).Wait(1000)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-HealthEndpoint {
    param(
        [int]$Port,
        [string]$ProjectRoot
    )

    $scriptPath = Join-Path $ProjectRoot 'scripts\check-health.cjs'
    & node $scriptPath $Port | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Should-AutoOpenDashboard {
    param([string]$EnvPath)

    $value = Get-EnvValue -Key 'HUB_AUTO_OPEN_DASHBOARD' -FilePath $EnvPath -Default 'true'
    return -not ($value -match '^(false|0|no)$')
}

function Open-Dashboard {
    param([int]$Port)

    try {
        Start-Process "http://127.0.0.1:$Port/dashboard" | Out-Null
    } catch {
        Write-Host 'Warning: failed to open the dashboard automatically. Open it manually in your browser if needed.'
    }
}

try {
    $projectRoot = Split-Path $PSScriptRoot -Parent
    $envPath = Join-Path $projectRoot '.env'
    $examplePath = Join-Path $projectRoot '.env.example'
    $distPath = Join-Path $projectRoot 'dist\index.js'

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'node.exe not found. Install Node.js 18+ first.'
    }

    $nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 18) {
        throw "Node.js 18+ required. Found: $(node --version)"
    }

    if (-not (Test-Path $distPath)) {
        throw 'dist\index.js not found. Run install.bat first.'
    }

    if (-not (Test-Path $envPath)) {
        if (-not (Test-Path $examplePath)) {
            throw '.env and .env.example are both missing.'
        }

        Copy-Item $examplePath $envPath
        Write-Host 'Created .env from .env.example. Review it before running again.'
        exit 1
    }

    $port = [int](Get-EnvValue -Key 'HUB_PORT' -FilePath $envPath -Default '3000')
    $logDir = Resolve-ProjectPath -ProjectRoot $projectRoot -PathValue (Get-EnvValue -Key 'HUB_LOG_DIR' -FilePath $envPath -Default '.\logs')
    $pidFile = Join-Path $logDir 'hub.pid'

    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir | Out-Null
    }

    if (Test-Path $pidFile) {
        $existingPid = [int](Get-Content $pidFile | Select-Object -First 1)
        $existingProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($existingProcess) {
            Write-Host "AI Access Hub is already running (PID: $existingPid)"
            Write-Host "Dashboard: http://127.0.0.1:$port/dashboard"
            if (Should-AutoOpenDashboard -EnvPath $envPath) {
                Open-Dashboard -Port $port
            }
            exit 0
        }

        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }

    if (Test-Port -Port $port) {
        throw "Port $port is already in use. Stop the other process first."
    }

    Write-Host 'Starting AI Access Hub...'
    Write-Host "Dashboard: http://127.0.0.1:$port/dashboard"
    Write-Host "API:       http://127.0.0.1:$port/v1/"
    Write-Host 'Logs:      live output stays visible in the server console window'
    Write-Host 'Stop with: stop.bat'
    Write-Host 'Ready when: GET /health returns status=ok'

    $process = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru
    Set-Content -Path $pidFile -Value $process.Id

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if (-not $alive) {
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            Write-Host 'AI Access Hub exited during startup.'
            Write-Host 'Check the server console window for the last startup logs.'
            exit 1
        }

        if (Test-HealthEndpoint -Port $port -ProjectRoot $projectRoot) {
            Write-Host "AI Access Hub started (PID: $($process.Id))"
            Write-Host 'The server console window will stay open while logs are streaming.'
            if (Should-AutoOpenDashboard -EnvPath $envPath) {
                Open-Dashboard -Port $port
            }
            exit 0
        }

        Start-Sleep -Seconds 1
    }

    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'AI Access Hub did not become ready in time.'
    Write-Host 'Check the server console window for the last startup logs.'
    exit 1
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    exit 1
}