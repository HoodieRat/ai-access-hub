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
    $processId = $null

    if (Test-Path $pidFile) {
        $rawPid = Get-Content $pidFile | Select-Object -First 1
        if ($rawPid) {
            $processId = [int]$rawPid
        }
    }

    if (-not $processId -and -not (Test-Port -Port $port)) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        Write-Host 'AI Access Hub is not running.'
        exit 0
    }

    if ($adminToken) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/v1/admin/shutdown" -Method POST -Headers @{ Authorization = "Bearer $adminToken" } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -UseBasicParsing | Out-Null
        } catch {
            Write-Host 'Graceful shutdown request failed; falling back to process stop if needed.'
        }
    }

    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $alive = $false
        if ($processId) {
            $alive = [bool](Get-Process -Id $processId -ErrorAction SilentlyContinue)
        }

        if (-not $alive -and -not (Test-Port -Port $port)) {
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            Write-Host 'AI Access Hub stopped.'
            exit 0
        }

        Start-Sleep -Seconds 1
    }

    if ($processId) {
        Write-Host "Graceful shutdown timed out. Force stopping PID $processId..."
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }

    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'AI Access Hub stopped.'
    exit 0
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    exit 1
}