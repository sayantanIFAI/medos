# Opens a private SSH tunnel from this computer to the AI host on the GPU pod, so MedOS can call it at http://127.0.0.1:8765.
# Only a pipe runs here: no AI model, no OCR, no speech. Leave this window open while using the Assistant; it reconnects if the link drops.
#
# The pod's address is read from .local\pod.env (not committed):
#   POD_HOST=<pod ip address>
#   POD_PORT=<pod ssh port>
#   POD_KEY=C:\Users\<you>\.ssh\id_ed25519
param([int]$LocalPort = 8765)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cfg = @{ POD_HOST = ''; POD_PORT = '22'; POD_KEY = (Join-Path $env:USERPROFILE '.ssh\id_ed25519') }
$file = Join-Path $root '.local\pod.env'
if (Test-Path $file) {
  Get-Content $file | ForEach-Object { if ($_ -match '^\s*(POD_HOST|POD_PORT|POD_KEY)\s*=\s*(\S+)\s*$') { $cfg[$Matches[1]] = $Matches[2] } }
}
if (-not $cfg.POD_HOST) { throw "Put POD_HOST, POD_PORT and POD_KEY in $file first." }

while ($true) {
  Write-Host "$(Get-Date -Format T) tunnel 127.0.0.1:$LocalPort -> pod $($cfg.POD_HOST):$($cfg.POD_PORT)"
  ssh -N -p $cfg.POD_PORT -i $cfg.POD_KEY -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 `
    -L "127.0.0.1:${LocalPort}:127.0.0.1:8765" "root@$($cfg.POD_HOST)"
  Write-Host "$(Get-Date -Format T) tunnel closed, reconnecting in 5 s (Ctrl+C to stop)"
  Start-Sleep -Seconds 5
}
