Set-StrictMode -Version Latest

function Get-SetupProjectRoot {
    param(
        [Parameter(Mandatory)]
        [string]$ScriptRoot
    )

    return [System.IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..\..'))
}

function Test-CommandAvailable {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-EnvMap {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath
    )

    $map = [ordered]@{}

    if (-not (Test-Path $FilePath)) {
        return $map
    }

    foreach ($line in Get-Content $FilePath -ErrorAction Stop) {
        if ($line -match '^\s*#' -or $line -match '^\s*$') {
            continue
        }

        $match = [regex]::Match($line, '^\s*([^#=\s]+)\s*=(.*)$')
        if ($match.Success) {
            $map[$match.Groups[1].Value] = $match.Groups[2].Value
        }
    }

    return $map
}

function Get-EnvValue {
    param(
        [Parameter(Mandatory)]
        [string]$Key,
        [Parameter(Mandatory)]
        [string]$FilePath,
        [string]$Default = ''
    )

    $map = Get-EnvMap -FilePath $FilePath
    if ($map.Contains($Key)) {
        return [string]$map[$Key]
    }

    return $Default
}

function Resolve-SetupPath {
    param(
        [Parameter(Mandatory)]
        [string]$ProjectRoot,
        [Parameter(Mandatory)]
        [string]$PathValue
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $null
    }

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return $PathValue
    }

    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $PathValue))
}

function Expand-SetupValue {
    param(
        [string]$Value,
        [hashtable]$Variables
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $Value
    }

    $expanded = $Value
    foreach ($key in $Variables.Keys) {
        $token = '{' + $key + '}'
        $replacement = ''
        if ($null -ne $Variables[$key]) {
            $replacement = [string]$Variables[$key]
        }

        $expanded = $expanded.Replace($token, $replacement)
    }

    return $expanded
}

function Test-Port {
    param(
        [Parameter(Mandatory)]
        [int]$Port,
        [string]$Host = '127.0.0.1'
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $null = $client.ConnectAsync($Host, $Port).Wait(1000)
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-HttpEndpoint {
    param(
        [Parameter(Mandatory)]
        [string]$Url,
        [int]$TimeoutSeconds = 3
    )

    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -UseBasicParsing -TimeoutSec $TimeoutSeconds
        return [pscustomobject]@{
            Url        = $Url
            Success    = $true
            StatusCode = [int]$response.StatusCode
            Error      = $null
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        return [pscustomobject]@{
            Url        = $Url
            Success    = $false
            StatusCode = $statusCode
            Error      = $_.Exception.Message
        }
    }
}

function Get-ProcessMatches {
    param(
        [string[]]$Patterns
    )

    $items = @($Patterns | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($items.Count -eq 0) {
        return @()
    }

    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $processName = $_.ProcessName
        foreach ($pattern in $items) {
            if ($processName -like $pattern) {
                return $true
            }
        }

        return $false
    })
}

function Find-ExistingPath {
    param(
        [string[]]$CandidatePaths,
        [Parameter(Mandatory)]
        [string]$ProjectRoot
    )

    foreach ($candidate in @($CandidatePaths)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        $resolved = Resolve-SetupPath -ProjectRoot $ProjectRoot -PathValue $candidate
        if ($resolved -and (Test-Path $resolved)) {
            return $resolved
        }
    }

    return $null
}

function Find-ExistingCommand {
    param(
        [string[]]$CandidateCommands
    )

    foreach ($candidate in @($CandidateCommands)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            if ($command.Source) {
                return $command.Source
            }

            return $command.Name
        }
    }

    return $null
}

function Get-DockerState {
    $result = [ordered]@{
        Available        = $false
        DaemonRunning    = $false
        ComposeAvailable = $false
        ComposeCommand   = $null
        ComposeArgs      = @()
        ClientVersion    = $null
        Error            = $null
    }

    if (-not (Test-CommandAvailable -Name 'docker')) {
        return [pscustomobject]$result
    }

    $result.Available = $true

    try {
        $clientVersion = (& docker version --format '{{.Client.Version}}' 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $clientVersion) {
            $result.ClientVersion = $clientVersion
        }
    } catch {
        $result.Error = $_.Exception.Message
    }

    try {
        $null = & docker info --format '{{.ServerVersion}}' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $result.DaemonRunning = $true
        }
    } catch {
        if (-not $result.Error) {
            $result.Error = $_.Exception.Message
        }
    }

    try {
        $null = & docker compose version 2>$null
        if ($LASTEXITCODE -eq 0) {
            $result.ComposeAvailable = $true
            $result.ComposeCommand = 'docker'
            $result.ComposeArgs = @('compose')
        }
    } catch {
    }

    if (-not $result.ComposeAvailable -and (Test-CommandAvailable -Name 'docker-compose')) {
        $result.ComposeAvailable = $true
        $result.ComposeCommand = 'docker-compose'
        $result.ComposeArgs = @()
    }

    return [pscustomobject]$result
}

function Get-DockerContainerMatches {
    param(
        [string[]]$Names
    )

    $dockerState = Get-DockerState
    if (-not ($dockerState.Available -and $dockerState.DaemonRunning)) {
        return @()
    }

    $items = @($Names | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($items.Count -eq 0) {
        return @()
    }

    $rows = @(& docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' 2>$null)
    $matches = @()
    foreach ($row in $rows) {
        $parts = $row -split '\|', 3
        if ($parts.Count -lt 3) {
            continue
        }

        foreach ($name in $items) {
            if ($parts[0] -eq $name) {
                $matches += [pscustomobject]@{
                    Name   = $parts[0]
                    State  = $parts[1]
                    Status = $parts[2]
                }
                break
            }
        }
    }

    return $matches
}

function Merge-EnvTemplate {
    param(
        [Parameter(Mandatory)]
        [string]$TemplatePath,
        [Parameter(Mandatory)]
        [string]$TargetPath
    )

    if (-not (Test-Path $TemplatePath)) {
        throw "Template env file not found: $TemplatePath"
    }

    $result = [ordered]@{
        Created   = $false
        BackupPath = $null
        AddedKeys = @()
        TargetPath = $TargetPath
    }

    if (-not (Test-Path $TargetPath)) {
        Copy-Item $TemplatePath $TargetPath
        $result.Created = $true
        $result.AddedKeys = @((Get-EnvMap -FilePath $TemplatePath).Keys)
        return [pscustomobject]$result
    }

    $existingMap = Get-EnvMap -FilePath $TargetPath
    $templateLines = Get-Content $TemplatePath -ErrorAction Stop
    $currentLines = Get-Content $TargetPath -ErrorAction Stop
    $appendLines = New-Object System.Collections.Generic.List[string]
    $pendingLines = New-Object System.Collections.Generic.List[string]

    foreach ($line in $templateLines) {
        if ($line -match '^\s*$' -or $line -match '^\s*#') {
            $pendingLines.Add($line)
            continue
        }

        $match = [regex]::Match($line, '^\s*([^#=\s]+)\s*=')
        if (-not $match.Success) {
            $pendingLines.Clear()
            continue
        }

        $key = $match.Groups[1].Value
        if ($existingMap.Contains($key)) {
            $pendingLines.Clear()
            continue
        }

        if ($appendLines.Count -gt 0 -and $appendLines[$appendLines.Count - 1] -ne '') {
            $appendLines.Add('')
        }

        foreach ($pendingLine in $pendingLines) {
            $appendLines.Add($pendingLine)
        }

        $appendLines.Add($line)
        $result.AddedKeys += $key
        $pendingLines.Clear()
    }

    if ($result.AddedKeys.Count -eq 0) {
        return [pscustomobject]$result
    }

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = "$TargetPath.backup.$timestamp"
    Copy-Item $TargetPath $backupPath
    $result.BackupPath = $backupPath

    $mergedLines = New-Object System.Collections.Generic.List[string]
    foreach ($line in $currentLines) {
        $mergedLines.Add($line)
    }

    if ($mergedLines.Count -gt 0 -and $mergedLines[$mergedLines.Count - 1] -ne '') {
        $mergedLines.Add('')
    }

    foreach ($line in $appendLines) {
        $mergedLines.Add($line)
    }

    Set-Content -Path $TargetPath -Value $mergedLines -Encoding ASCII

    return [pscustomobject]$result
}

function Write-SetupSection {
    param(
        [Parameter(Mandatory)]
        [string]$Title
    )

    Write-Host ''
    Write-Host ("== " + $Title + " ==")
}

function Write-SetupReport {
    param(
        [Parameter(Mandatory)]
        [psobject]$Summary
    )

    Write-SetupSection -Title ($Summary.stackName + ' summary')

    foreach ($component in $Summary.components) {
        $status = 'missing'
        if ($component.healthy) {
            $status = 'healthy'
        } elseif ($component.running) {
            $status = 'running'
        } elseif ($component.detected) {
            $status = 'detected'
        }

        $details = @()
        if ($component.port) {
            $details += ('port ' + $component.port)
        }
        if ($component.path) {
            $details += $component.path
        }
        if ($component.containerNames -and $component.containerNames.Count -gt 0) {
            $details += ('containers: ' + ($component.containerNames -join ', '))
        }
        if ($component.healthUrl) {
            $details += $component.healthUrl
        }

        if ($details.Count -eq 0) {
            Write-Host ("- " + $component.displayName + ': ' + $status)
        } else {
            Write-Host ("- " + $component.displayName + ': ' + $status + ' (' + ($details -join '; ') + ')')
        }

        foreach ($issue in @($component.issues)) {
            if (-not [string]::IsNullOrWhiteSpace($issue)) {
                Write-Host ("  issue: " + $issue)
            }
        }
    }

    if ($Summary.nextSteps -and $Summary.nextSteps.Count -gt 0) {
        Write-SetupSection -Title 'Next steps'
        $index = 1
        foreach ($step in $Summary.nextSteps) {
            Write-Host (([string]$index) + '. ' + $step)
            $index++
        }
    }
}

Export-ModuleMember -Function Get-SetupProjectRoot, Test-CommandAvailable, Get-EnvMap, Get-EnvValue, Resolve-SetupPath, Expand-SetupValue, Test-Port, Test-HttpEndpoint, Get-ProcessMatches, Find-ExistingPath, Find-ExistingCommand, Get-DockerState, Get-DockerContainerMatches, Merge-EnvTemplate, Write-SetupSection, Write-SetupReport