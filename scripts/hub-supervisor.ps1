[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$script:SupervisorLogPath = $null

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

function Write-SupervisorEvent {
    param([string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = '[' + $timestamp + '] ' + $Message
    Write-Host $line

    if ($script:SupervisorLogPath) {
        Add-Content -Path $script:SupervisorLogPath -Value $line -Encoding ASCII
    }
}

try {
    $envPath = Join-Path $ProjectRoot '.env'
    $distPath = Join-Path $ProjectRoot 'dist\index.js'

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'node.exe not found. Install Node.js 18+ first.'
    }

    if (-not (Test-Path $envPath)) {
        throw '.env is missing. Run install.bat or review your hub setup first.'
    }

    if (-not (Test-Path $distPath)) {
        throw 'dist\index.js not found. Run install.bat first.'
    }

    $port = [int](Get-EnvValue -Key 'HUB_PORT' -FilePath $envPath -Default '3000')
    $logDir = Resolve-ProjectPath -ProjectRoot $ProjectRoot -PathValue (Get-EnvValue -Key 'HUB_LOG_DIR' -FilePath $envPath -Default '.\logs')
    $pidFile = Join-Path $logDir 'hub.pid'
    $supervisorPidFile = Join-Path $logDir 'hub-supervisor.pid'
    $stopFile = Join-Path $logDir 'hub-supervisor.stop'
    $script:SupervisorLogPath = Join-Path $logDir 'hub-supervisor.log'

    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir | Out-Null
    }

    Set-Content -Path $supervisorPidFile -Value $PID -Encoding ASCII
    Write-SupervisorEvent "Hub supervisor online for port $port."

    $attempt = 0
    while ($true) {
        if (Test-Path $stopFile) {
            Write-SupervisorEvent 'Stop requested before launch. Supervisor exiting.'
            break
        }

        $attempt += 1
        Write-SupervisorEvent "Launching AI Access Hub node process (attempt $attempt)."

        try {
            $process = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru
        } catch {
            Write-SupervisorEvent ("Failed to launch node.exe: " + $_.Exception.Message)
            Start-Sleep -Seconds 2
            continue
        }

        Set-Content -Path $pidFile -Value $process.Id -Encoding ASCII

        while (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
            Start-Sleep -Seconds 1
        }

        $exitCode = $null
        try {
            $process.Refresh()
            if ($process.HasExited) {
                $exitCode = $process.ExitCode
            }
        } catch {
            $exitCode = $null
        }

        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue

        if (Test-Path $stopFile) {
            if ($null -ne $exitCode) {
                Write-SupervisorEvent ("Stop requested. Hub process exited with code $exitCode.")
            } else {
                Write-SupervisorEvent 'Stop requested. Hub process exited.'
            }
            break
        }

        if ($null -ne $exitCode) {
            Write-SupervisorEvent ("Hub process exited unexpectedly with code $exitCode. Restarting in 2s.")
        } else {
            Write-SupervisorEvent 'Hub process exited unexpectedly. Restarting in 2s.'
        }
        Start-Sleep -Seconds 2
    }
} catch {
    Write-SupervisorEvent ("Fatal supervisor error: " + $_.Exception.Message)
    exit 1
} finally {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
}