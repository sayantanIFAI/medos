# Starts everything for the front-desk demo, each piece detached so it keeps running: the local database, the SSH tunnel to the AI pod, the MedOS
# API and web, and the two separate apps (voicebot on :5101, OCR reader on :5102). Safe to run again: a piece that is already listening is left alone.
#   scripts\apps-up.ps1          start what is not running
#   scripts\apps-up.ps1 -Stop    stop the tunnel, API, web and the two apps (the database is left running)
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$logs = Join-Path $root '.local'

function Test-Port([int]$p) { (Test-NetConnection 127.0.0.1 -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded }
function Start-Detached([string]$cmd) { Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root } | Out-Null }

if ($Stop) {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'apps.api.dist.main.js|apps.voicebot.dist.main.js|apps.ocr-app.dist.main.js|next.*dev|medos.apps.web') -or
    ($_.Name -match 'powershell|ssh' -and $_.CommandLine -match 'ai-tunnel.ps1|8765:127.0.0.1:8765')
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host 'Stopped the tunnel, API, web and both apps.'
  return
}

& (Join-Path $PSScriptRoot 'db-up.ps1')
if (-not (Test-Port 8765)) { Start-Detached "powershell -NoProfile -ExecutionPolicy Bypass -File $root\scripts\ai-tunnel.ps1" }
if (-not (Test-Port 4000)) { Start-Detached "cmd /c powershell -NoProfile -ExecutionPolicy Bypass -File $root\scripts\dev-api.ps1 > $logs\api.log 2> $logs\api.err" }
if (-not (Test-Port 3000)) { Start-Detached "cmd /c pnpm --filter @medos/web dev > $logs\web.log 2> $logs\web.err" }
if (-not (Test-Port 5101)) { Start-Detached "cmd /c node $root\apps\voicebot\dist\main.js > $logs\voicebot.log 2> $logs\voicebot.err" }
if (-not (Test-Port 5102)) { Start-Detached "cmd /c node $root\apps\ocr-app\dist\main.js > $logs\ocr-app.log 2> $logs\ocr-app.err" }

Start-Sleep -Seconds 20
foreach ($x in @(@('AI pod tunnel', 8765), @('MedOS API', 4000), @('MedOS web   http://localhost:3000', 3000), @('Voicebot    http://localhost:5101', 5101), @('OCR reader  http://localhost:5102', 5102))) {
  Write-Host ("{0,-40} {1}" -f $x[0], $(if (Test-Port $x[1]) { 'up' } else { 'NOT UP (see .local\*.err)' }))
}
