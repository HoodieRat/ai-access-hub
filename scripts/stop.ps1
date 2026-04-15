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

function Remove-StaleFile {
    param([string]$FilePath)

    Remove-Item $FilePath -Force -ErrorAction SilentlyContinue
}

try {
    $projectRoot = Split-Path $PSScriptRoot -Parent
    $envPath = Join-Path $projectRoot '.env'
    if (-not (Test-Path $envPath)) {
        Write-Host 'AI Access Hub is not configured yet (.env missing).'
        exit 0
    }

    $port = [int](Get-EnvValue -Key 'HUB_PORT' -FilePath $envPath -Default '3000')
    $adminToken = Get-EnvValue -Key 'HUB_ADMIN_TOKEN' -FilePath $envPath
    $logDir = Resolve-ProjectPath -ProjectRoot $projectRoot -PathValue (Get-EnvValue -Key 'HUB_LOG_DIR' -FilePath $envPath -Default '.\logs')
    $pidFile = Join-Path $logDir 'hub.pid'
    $supervisorPidFile = Join-Path $logDir 'hub-supervisor.pid'
    $stopFile = Join-Path $logDir 'hub-supervisor.stop'
    $processId = Read-RecordedProcessId -FilePath $pidFile
    $supervisorProcessId = Read-RecordedProcessId -FilePath $supervisorPidFile

    if (-not (Get-LiveProcess -ProcessId $processId)) {
        Remove-StaleFile -FilePath $pidFile
        $processId = $null
    }

    if (-not (Get-LiveProcess -ProcessId $supervisorProcessId)) {
        Remove-StaleFile -FilePath $supervisorPidFile
        $supervisorProcessId = $null
    }

    if (-not $processId -and -not $supervisorProcessId -and -not (Test-Port -Port $port)) {
        Remove-StaleFile -FilePath $pidFile
        Remove-StaleFile -FilePath $supervisorPidFile
        Write-Host 'AI Access Hub is not running.'
        exit 0
    }

    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir | Out-Null
    }

    Set-Content -Path $stopFile -Value 'stop requested by stop.ps1' -Encoding ASCII

    if ($adminToken) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/v1/admin/shutdown" -Method POST -Headers @{ Authorization = "Bearer $adminToken" } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -UseBasicParsing | Out-Null
        } catch {
            Write-Host 'Graceful shutdown request failed; falling back to process stop if needed.'
        }
    }

    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        $childAlive = [bool](Get-LiveProcess -ProcessId $processId)
        $supervisorAlive = [bool](Get-LiveProcess -ProcessId $supervisorProcessId)

        if (-not $childAlive -and -not $supervisorAlive -and -not (Test-Port -Port $port)) {
            Remove-StaleFile -FilePath $pidFile
            Remove-StaleFile -FilePath $supervisorPidFile
            Remove-StaleFile -FilePath $stopFile
            Write-Host 'AI Access Hub stopped.'
            exit 0
        }

        Start-Sleep -Seconds 1
    }

    if ($processId) {
        Write-Host "Graceful shutdown timed out. Force stopping PID $processId..."
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }

    if ($supervisorProcessId) {
        Write-Host "Stopping supervisor PID $supervisorProcessId..."
        Stop-Process -Id $supervisorProcessId -Force -ErrorAction SilentlyContinue
    }

    Remove-StaleFile -FilePath $pidFile
    Remove-StaleFile -FilePath $supervisorPidFile
    Remove-StaleFile -FilePath $stopFile

    if (Test-Port -Port $port) {
        Write-Host "Warning: port $port is still in use after shutdown."
        exit 1
    }

    Write-Host 'AI Access Hub stopped.'
    exit 0
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    exit 1
}