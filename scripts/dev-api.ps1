# Starts the API against the local dev database (run scripts\db-up.ps1 first; seed with `pnpm db:seed`).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:PRISMA_ENGINES_CACHE_DIR = 'D:\.cache\prisma'
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = 'postgresql://medos@127.0.0.1:54329/medos_dev' }
if (-not $env:JWT_ACCESS_SECRET) { $env:JWT_ACCESS_SECRET = 'dev-only-secret-dev-only-secret-0001' }
if (-not $env:SCRYPT_LOG_N) { $env:SCRYPT_LOG_N = '14' }
# Prescription reading, speech and the language model run on a remote AI host (a GPU pod reached by scripts\ai-tunnel.ps1, apps\ai-host), never on this
# computer. The notebook prints AI_REMOTE_URL and AI_REMOTE_TOKEN; paste those two lines into .local\ai-remote.env (not committed).
$aiEnv = Join-Path $root '.local\ai-remote.env'
if (Test-Path $aiEnv) {
  Get-Content $aiEnv | ForEach-Object { if ($_ -match '^\s*(AI_REMOTE_URL|AI_REMOTE_TOKEN|ASSISTANT_LLM_MODEL)\s*=\s*(\S+)\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] } }
}
$env:PORT = '4000'
$env:CORS_ORIGINS = 'http://localhost:3000'
Set-Location $root
node apps\api\dist\main.js
