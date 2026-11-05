#!/usr/bin/env bash
# Deploys all of MedOS on a RunPod GPU pod from git, and starts it. Run it ON the pod as root; safe to run again (it updates and restarts).
#
#   ssh -p <port> root@<pod> 'bash -s' < deploy/pod/deploy.sh        # first time, straight from this repo
#   /workspace/medos-deploy/medos/deploy/pod/deploy.sh               # later, to pull the latest code and restart
#
# What it sets up (everything persistent lives under /workspace/medos-deploy, the pod's volume; nothing outside /workspace/medos-deploy and
# /workspace/medos-ai is touched, because that volume is shared with other projects):
#   - Node 22, pnpm, PostgreSQL 16 and cloudflared (the pod's own disk, reinstalled when the pod is recreated)
#   - the code, cloned from GitHub (MEDOS_REPO / MEDOS_BRANCH)
#   - the AI host (OCR with a vision model, speech, voice, language model) via apps/ai-host, models cached in /workspace/medos-ai
#   - MedOS API + web, the voicebot app and the OCR app, each started as its own process
#   - three public HTTPS addresses (Cloudflare quick tunnels): the web app, the voicebot and the OCR reader; the apps ask for a login
# The demo hospital is synthetic data. Its login is written to /workspace/medos-deploy/secrets/login.txt (never to the repo or the logs).
set -euo pipefail

REPO=${MEDOS_REPO:-https://github.com/sayantanIFAI/medos.git}
BRANCH=${MEDOS_BRANCH:-main}
ROOT=/workspace/medos-deploy
SRC=$ROOT/medos
SECRETS=$ROOT/secrets
LOGS=$ROOT/logs
PGDATA=$ROOT/pgdata
TENANT=${MEDOS_TENANT:-demo}
mkdir -p "$ROOT" "$SECRETS" "$LOGS" "$ROOT/storage"
chmod 700 "$SECRETS"
export DEBIAN_FRONTEND=noninteractive

say() { echo; echo "== $*"; }

say "runtime (Node 22, pnpm, PostgreSQL, cloudflared)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz | tar -xJ -C /opt
  ln -sf /opt/node-v22.14.0-linux-x64/bin/node /usr/local/bin/node
  ln -sf /opt/node-v22.14.0-linux-x64/bin/npm /usr/local/bin/npm
  ln -sf /opt/node-v22.14.0-linux-x64/bin/npx /usr/local/bin/npx
fi
command -v pnpm >/dev/null || { npm install -g pnpm@9.15.9 >/dev/null; ln -sf /opt/node-v22.14.0-linux-x64/bin/pnpm /usr/local/bin/pnpm; }
if ! command -v pg_ctlcluster >/dev/null || [ ! -x /usr/lib/postgresql/16/bin/postgres ]; then
  apt-get update -qq && apt-get install -y -qq postgresql postgresql-contrib poppler-utils >/dev/null
  systemctl stop postgresql 2>/dev/null || service postgresql stop 2>/dev/null || true
fi
command -v cloudflared >/dev/null || { curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared; }

say "code from $REPO ($BRANCH)"
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q origin "$BRANCH" && git -C "$SRC" reset -q --hard "origin/$BRANCH"; else git clone -q --branch "$BRANCH" "$REPO" "$SRC"; fi
git -C "$SRC" log --oneline -1
cd "$SRC"
sed -i 's/\r$//' deploy/pod/*.sh; chmod +x deploy/pod/*.sh

say "secrets (created once, kept on the volume)"
mk() { [ -s "$SECRETS/$1" ] || { head -c "$2" /dev/urandom | base64 | tr -d '/+=\n' | head -c "$3" > "$SECRETS/$1"; chmod 600 "$SECRETS/$1"; }; }
mk jwt-secret 48 48
mk db-password 24 24
mk demo-password 24 18
DB_PASSWORD=$(cat "$SECRETS/db-password")
DEMO_PASSWORD="Dm1-$(cat "$SECRETS/demo-password")"   # satisfies the password policy: upper, lower, digit, symbol

say "database (PostgreSQL 16, data on the volume)"
PGBIN=/usr/lib/postgresql/16/bin
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
  su postgres -c "$PGBIN/initdb -D $PGDATA -E UTF8 --locale=C.UTF-8 -A scram-sha-256 --pwfile=<(echo '$DB_PASSWORD')" >/dev/null
fi
if ! su postgres -c "$PGBIN/pg_isready -q -h 127.0.0.1 -p 5432"; then
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 5432 -c listen_addresses=127.0.0.1' -l $LOGS/postgres.log -w start" >/dev/null
fi
export PGPASSWORD="$DB_PASSWORD"
psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='medos'" | grep -q 1 || psql -h 127.0.0.1 -U postgres -qc "CREATE DATABASE medos"
export DATABASE_URL="postgresql://postgres:$DB_PASSWORD@127.0.0.1:5432/medos"

say "AI host (vision-model OCR, speech, voice, language model) in /workspace/medos-ai"
AI=/workspace/medos-ai
mkdir -p "$AI/app" "$AI/logs"
cp apps/ai-host/server.py apps/ai-host/speech_prep.py apps/ai-host/vlm_read.py "$AI/app/"
cp apps/ai-host/pod/setup.sh apps/ai-host/pod/start.sh "$AI/"
sed -i 's/\r$//' "$AI/setup.sh" "$AI/start.sh"; chmod +x "$AI/setup.sh" "$AI/start.sh"
[ -x /opt/medos-ai-venv/bin/python ] && /opt/medos-ai-venv/bin/python -c "import faster_whisper, easyocr, fastapi" 2>/dev/null || (cd "$AI" && ./setup.sh > logs/setup.log 2>&1)
(cd "$AI" && (setsid nohup ./start.sh > logs/start.log 2>&1 < /dev/null &)) ; sleep 2

say "build (pnpm install, Prisma, API, web, apps)"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @medos/database build >/dev/null
pnpm --filter @medos/shared build >/dev/null
pnpm --filter @medos/frontdesk-core build >/dev/null
pnpm --filter @medos/api build >/dev/null
pnpm --filter @medos/voicebot build >/dev/null
pnpm --filter @medos/ocr-app build >/dev/null
pnpm --filter @medos/web build >/dev/null
(cd packages/database && pnpm exec prisma migrate deploy)

say "demo hospital '$TENANT' (synthetic data), lab catalogue, and the two apps' own MedOS users"
export JWT_ACCESS_SECRET=$(cat "$SECRETS/jwt-secret") SCRYPT_LOG_N=14 STORAGE_DIR=$ROOT/storage
mkdir -p .local
printf 'AI_REMOTE_URL=http://127.0.0.1:8765\nAI_REMOTE_TOKEN=%s\nASSISTANT_LLM_MODEL=qwen2.5:14b\n' "$(cat $AI/token 2>/dev/null || true)" > .local/ai-remote.env
chmod 600 .local/ai-remote.env
cat > "$ROOT/api.env" <<EOF
DATABASE_URL=$DATABASE_URL
JWT_ACCESS_SECRET=$JWT_ACCESS_SECRET
SCRYPT_LOG_N=14
STORAGE_DIR=$STORAGE_DIR
PORT=4000
CORS_ORIGINS=http://127.0.0.1:3000
AI_REMOTE_URL=http://127.0.0.1:8765
EOF
chmod 600 "$ROOT/api.env"

# run the API briefly on its own to seed and provision through it
"$SRC/deploy/pod/services.sh" stop >/dev/null 2>&1 || true
(set -a; . "$ROOT/api.env"; set +a; export AI_REMOTE_TOKEN=$(cat "$AI/token" 2>/dev/null || true); cd "$SRC"; setsid nohup node apps/api/dist/main.js > "$LOGS/api.log" 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:4000/api/v1/nothing && break; sleep 1; done
if ! psql -h 127.0.0.1 -U postgres -d medos -tAc "SELECT 1 FROM \"Tenant\" WHERE code='$TENANT'" | grep -q 1; then
  SEED_PASSWORD="$DEMO_PASSWORD" SEED_PROFILE=small SEED_TENANT_CODE="$TENANT" node apps/api/dist/cli/seed.js 2>&1 | tail -n 4
fi
MEDOS_ADMIN_PASSWORD="$DEMO_PASSWORD" node scripts/import-lab-catalogue.mjs --tenant "$TENANT" --api http://127.0.0.1:4000/api/v1 | tail -n 1
MEDOS_ADMIN_PASSWORD="$DEMO_PASSWORD" node scripts/frontdesk-apps-provision.mjs --tenant "$TENANT" --api http://127.0.0.1:4000/api/v1 | tail -n 2
printf 'hospital code: %s\nuser: reception1 (also admin, doctor1, nurse1, cashier1, pharmacist1, manager1)\npassword: %s\n' "$TENANT" "$DEMO_PASSWORD" > "$SECRETS/login.txt"
chmod 600 "$SECRETS/login.txt"

say "start everything"
"$SRC/deploy/pod/services.sh" restart
