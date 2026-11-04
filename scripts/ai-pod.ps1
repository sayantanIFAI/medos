# Makes sure the AI host is running on the GPU pod (starts it if the pod was restarted). Reads .local\pod.env (see ai-tunnel.ps1).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cfg = @{ POD_HOST = ''; POD_PORT = '22'; POD_KEY = (Join-Path $env:USERPROFILE '.ssh\id_ed25519') }
$file = Join-Path $root '.local\pod.env'
if (Test-Path $file) { Get-Content $file | ForEach-Object { if ($_ -match '^\s*(POD_HOST|POD_PORT|POD_KEY)\s*=\s*(\S+)\s*$') { $cfg[$Matches[1]] = $Matches[2] } } }
if (-not $cfg.POD_HOST) { throw "Put POD_HOST, POD_PORT and POD_KEY in $file first." }
$ssh = @('-p', $cfg.POD_PORT, '-i', $cfg.POD_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', "root@$($cfg.POD_HOST)")
$health = ssh @ssh "curl -s -m 5 http://127.0.0.1:8765/health"
if ($health -match '"ok":true') { Write-Host "AI host is running: $health"; return }
if (-not (ssh @ssh "test -x /workspace/medos-ai/start.sh && echo yes")) { throw "Host not installed on this pod: copy apps\ai-host\server.py and pod\*.sh to /workspace/medos-ai and run setup.sh (see apps\ai-host\README.md)." }
if (-not (ssh @ssh "test -x /opt/medos-ai-venv/bin/python && echo yes")) { Write-Host "Pod disk was reset: rebuilding the Python environment (a few minutes)..."; ssh @ssh "cd /workspace/medos-ai && ./setup.sh > logs/setup.log 2>&1" }
ssh @ssh "cd /workspace/medos-ai && (setsid nohup ./start.sh > logs/start.log 2>&1 < /dev/null &); sleep 50; curl -s -m 5 http://127.0.0.1:8765/health"
