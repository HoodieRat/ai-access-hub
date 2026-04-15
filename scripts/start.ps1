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

function Read-RecordedProcessId {
    param([string]$FilePath)

    if (-not (Test-Path $FilePath)) {
        return $null
    }

    $rawValue = Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rawValue) {
        return $null
    }

    $parsedValue = 0
    if ([int]::TryParse($rawValue, [ref]$parsedValue)) {
        return $parsedValue
    }

    return $null
}

function Get-LiveProcess {
    param([int]$ProcessId)

    if (-not $ProcessId) {
        return $null
    }

    return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
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

function Remove-StaleFile {
    param([string]$FilePath)

    Remove-Item $FilePath -Force -ErrorAction SilentlyContinue
}

try {
    $projectRoot = Split-Path $PSScriptRoot -Parent
    $envPath = Join-Path $projectRoot '.env'
    $examplePath = Join-Path $projectRoot '.env.example'
    $distPath = Join-Path $projectRoot 'dist\index.js'
    $supervisorScriptPath = Join-Path $PSScriptRoot 'hub-supervisor.ps1'

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

    if (-not (Test-Path $supervisorScriptPath)) {
        throw 'scripts\hub-supervisor.ps1 not found. Restore the Windows launcher files and try again.'
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
    $supervisorPidFile = Join-Path $logDir 'hub-supervisor.pid'
    $stopFile = Join-Path $logDir 'hub-supervisor.stop'

    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir | Out-Null
    }

    $existingPid = Read-RecordedProcessId -FilePath $pidFile
    $existingProcess = Get-LiveProcess -ProcessId $existingPid
    if (-not $existingProcess) {
        Remove-StaleFile -FilePath $pidFile
    }

    $existingSupervisorPid = Read-RecordedProcessId -FilePath $supervisorPidFile
    $existingSupervisorProcess = Get-LiveProcess -ProcessId $existingSupervisorPid
    if (-not $existingSupervisorProcess) {
        Remove-StaleFile -FilePath $supervisorPidFile
    }

    if ($existingSupervisorProcess -or ($existingProcess -and (Test-Port -Port $port))) {
        if ($existingSupervisorProcess) {
            Write-Host "AI Access Hub is already running under supervision (PID: $existingSupervisorPid)"
        } else {
            Write-Host "AI Access Hub is already running (PID: $existingPid)"
        }

        if (Test-HealthEndpoint -Port $port -ProjectRoot $projectRoot) {
            Write-Host "Dashboard: http://127.0.0.1:$port/dashboard"
            if (Should-AutoOpenDashboard -EnvPath $envPath) {
                Open-Dashboard -Port $port
            }
            exit 0
        }

        Write-Host 'AI Access Hub is starting or unhealthy. Check the hub supervisor window for logs.'
        exit 1
    }

    if (Test-Port -Port $port) {
        throw "Port $port is already in use. Stop the other process first."
    }

    Remove-StaleFile -FilePath $stopFile

    Write-Host 'Starting AI Access Hub...'
    Write-Host "Dashboard: http://127.0.0.1:$port/dashboard"
    Write-Host "API:       http://127.0.0.1:$port/v1/"
    Write-Host 'Logs:      live output stays visible in the hub supervisor window'
    Write-Host 'Stop with: stop.bat'
    Write-Host 'Ready when: GET /health returns status=ok'

    $supervisorProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $supervisorScriptPath,
        '-ProjectRoot',
        $projectRoot
    ) -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $alive = Get-LiveProcess -ProcessId $supervisorProcess.Id
        if (-not $alive) {
            Remove-StaleFile -FilePath $pidFile
            Remove-StaleFile -FilePath $supervisorPidFile
            Write-Host 'AI Access Hub supervisor exited during startup.'
            Write-Host 'Check the hub supervisor window for the last startup logs.'
            exit 1
        }

        if (Test-HealthEndpoint -Port $port -ProjectRoot $projectRoot) {
            $recordedSupervisorPid = Read-RecordedProcessId -FilePath $supervisorPidFile
            if ($recordedSupervisorPid) {
                Write-Host "AI Access Hub started (Supervisor PID: $recordedSupervisorPid)"
            } else {
                Write-Host "AI Access Hub started (Supervisor PID: $($supervisorProcess.Id))"
            }
            Write-Host 'The hub supervisor window will stay open while logs are streaming.'
            if (Should-AutoOpenDashboard -EnvPath $envPath) {
                Open-Dashboard -Port $port
            }
            exit 0
        }

        Start-Sleep -Seconds 1
    }

    Set-Content -Path $stopFile -Value 'stop requested by startup timeout' -Encoding ASCII

    $startupChildPid = Read-RecordedProcessId -FilePath $pidFile
    $startupChildProcess = Get-LiveProcess -ProcessId $startupChildPid
    if ($startupChildProcess) {
        Stop-Process -Id $startupChildProcess.Id -Force -ErrorAction SilentlyContinue
    }

    Stop-Process -Id $supervisorProcess.Id -Force -ErrorAction SilentlyContinue
    Remove-StaleFile -FilePath $pidFile
    Remove-StaleFile -FilePath $supervisorPidFile
    Remove-StaleFile -FilePath $stopFile
    Write-Host 'AI Access Hub did not become ready in time.'
    Write-Host 'Check the hub supervisor window for the last startup logs.'
    exit 1
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    exit 1
}