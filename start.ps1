param([ValidateSet('start','install','update','setup','status','logs','restart','stop','run','uninstall','service')][string]$Command = 'start')
$ErrorActionPreference = 'Stop'
$InstallDir = if ($env:FUNPAY_BOT_HOME) { [IO.Path]::GetFullPath($env:FUNPAY_BOT_HOME) } elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data\config.json')) { $PSScriptRoot } else { Join-Path $env:USERPROFILE 'FunPayBot' }
$DataDir = Join-Path $InstallDir 'data'
$BotFile = Join-Path $InstallDir 'bot.mjs'
$LauncherFile = Join-Path $InstallDir 'start.ps1'
$EnabledFile = Join-Path $DataDir 'service.enabled'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'FunPayResellerBot'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Quote-Argument([string]$Value) { return '"' + $Value + '"' }

function Install-Files {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    if ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -ieq $InstallDir.TrimEnd('\')) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bot.mjs'))) { throw 'Extract the complete archive first: bot.mjs is missing.' }
    foreach ($Name in @('bot.mjs','start.ps1','start.cmd','start.sh','README.md','LOTS-GEMINI.md')) {
        $Source = Join-Path $PSScriptRoot $Name
        if (Test-Path -LiteralPath $Source) { Copy-Item -LiteralPath $Source -Destination (Join-Path $InstallDir $Name) -Force }
    }
    foreach ($Name in @('knowledge.md','lot-templates.json')) {
        $Source = Join-Path $PSScriptRoot $Name
        $Target = Join-Path $InstallDir $Name
        if (-not (Test-Path -LiteralPath $Source)) { continue }
        if (-not (Test-Path -LiteralPath $Target)) { Copy-Item -LiteralPath $Source -Destination $Target }
        elseif ((Get-FileHash -LiteralPath $Source).Hash -ne (Get-FileHash -LiteralPath $Target).Hash) {
            Copy-Item -LiteralPath $Source -Destination (Join-Path $InstallDir ($Name + '.new')) -Force
            Write-Host "Your $Name was preserved; the updated default is $Name.new"
        }
    }
}

function Test-Node([string]$Candidate) {
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate)) { return $false }
    try { return [int](& $Candidate -p 'process.versions.node.split(".")[0]') -ge 22 } catch { return $false }
}

function Find-Node {
    $SavedPath = Join-Path $DataDir 'node-path.txt'
    if (Test-Path -LiteralPath $SavedPath) {
        $Candidate = (Get-Content -LiteralPath $SavedPath -Raw).Trim()
        if (Test-Node $Candidate) { return $Candidate }
    }
    $SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($SystemNode -and (Test-Node $SystemNode.Source)) { return $SystemNode.Source }
    $Architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $BaseUrl = 'https://nodejs.org/dist/latest-v22.x'
    Write-Host 'Installing Node.js 22 from nodejs.org with SHA-256 verification...'
    $Checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHASUMS256.txt").Content
    $Match = [regex]::Match($Checksums, "(?m)^([a-f0-9]{64})  (node-v[0-9.]+-win-$Architecture\.zip)\r?$")
    if (-not $Match.Success) { throw 'No supported Node.js archive found on nodejs.org.' }
    $RuntimeDir = Join-Path $InstallDir 'runtime'
    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    $Archive = Join-Path $RuntimeDir $Match.Groups[2].Value
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$($Match.Groups[2].Value)" -OutFile $Archive
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ine $Match.Groups[1].Value) { throw 'Node.js checksum mismatch. The archive was not executed.' }
    Expand-Archive -LiteralPath $Archive -DestinationPath $RuntimeDir -Force
    $Candidate = Join-Path (Join-Path $RuntimeDir ([IO.Path]::GetFileNameWithoutExtension($Archive))) 'node.exe'
    if (-not (Test-Node $Candidate)) { throw 'The downloaded Node.js could not start.' }
    Set-Content -LiteralPath $SavedPath -Value $Candidate -Encoding UTF8
    return $Candidate
}

function Stop-Bot {
    if (Test-Path -LiteralPath $EnabledFile) { Remove-Item -LiteralPath $EnabledFile -Force }
    foreach ($Name in @('service.pid','bot.lock')) {
        $PidFile = Join-Path $DataDir $Name
        if (-not (Test-Path -LiteralPath $PidFile)) { continue }
        $BotProcessId = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$BotProcessId)) { continue }
        $Running = Get-CimInstance Win32_Process -Filter "ProcessId = $BotProcessId" -ErrorAction SilentlyContinue
        if ($Running -and $Running.CommandLine -and ($Running.CommandLine.Contains($BotFile) -or $Running.CommandLine.Contains($LauncherFile))) {
            Stop-Process -Id $BotProcessId -ErrorAction SilentlyContinue
        }
    }
}

function Start-Bot {
    Stop-Bot
    Set-Content -LiteralPath $EnabledFile -Value 'enabled'
    $Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Quote-Argument $LauncherFile) + ' service'
    New-Item -Path $RunKey -Force | Out-Null
    Set-ItemProperty -Path $RunKey -Name $RunName -Value ((Quote-Argument $PowerShellExe) + ' ' + $Arguments)
    Start-Process -FilePath $PowerShellExe -ArgumentList $Arguments -WorkingDirectory $InstallDir -WindowStyle Hidden | Out-Null
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
switch ($Command) {
    'service' {
        $Node = Find-Node
        if (-not (Test-Path -LiteralPath $EnabledFile)) { return }
        Set-Content -LiteralPath (Join-Path $DataDir 'service.pid') -Value $PID
        while (Test-Path -LiteralPath $EnabledFile) {
            $Child = Start-Process -FilePath $Node -ArgumentList ((Quote-Argument $BotFile) + ' run') -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataDir 'bot.log') -RedirectStandardError (Join-Path $DataDir 'bot-error.log')
            $Child.WaitForExit()
            if (Test-Path -LiteralPath $EnabledFile) { Start-Sleep -Seconds 15 }
        }
    }
    'stop' { Stop-Bot; Write-Host 'Bot stopped. Use start.cmd to start it again.' }
    'uninstall' { Stop-Bot; Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue; Write-Host "Autostart removed. Your settings and order history remain in $InstallDir" }
    'logs' {
        foreach ($Name in @('bot.log','bot-error.log')) { $LogFile = Join-Path $DataDir $Name; if (-not (Test-Path -LiteralPath $LogFile)) { New-Item -ItemType File -Path $LogFile | Out-Null } }
        Get-Content -LiteralPath @((Join-Path $DataDir 'bot.log'), (Join-Path $DataDir 'bot-error.log')) -Tail 60 -Wait
    }
    'status' { $Node = Find-Node; & $Node $BotFile status; if ($LASTEXITCODE -ne 0) { throw 'Status check failed.' } }
    'run' { Install-Files; $Node = Find-Node; & $Node $BotFile run }
    'setup' { Install-Files; $Node = Find-Node; Stop-Bot; & $Node $BotFile setup; if ($LASTEXITCODE -ne 0) { throw 'Setup did not finish.' }; Start-Bot }
    default {
        Stop-Bot; Install-Files; $Node = Find-Node
        if (-not (Test-Path -LiteralPath (Join-Path $DataDir 'config.json'))) { & $Node $BotFile setup; if ($LASTEXITCODE -ne 0) { throw 'Setup did not finish.' } }
        Start-Bot
        $Config = Get-Content -LiteralPath (Join-Path $DataDir 'config.json') -Raw | ConvertFrom-Json
        $Port = if ($Config.dashboardPort) { $Config.dashboardPort } else { 4777 }
        Write-Host "Bot started in the background. Dashboard: http://127.0.0.1:$Port"
        Write-Host 'Keep this computer awake and connected to the Internet.'
        Start-Process "http://127.0.0.1:$Port" -WindowStyle Hidden
    }
}
