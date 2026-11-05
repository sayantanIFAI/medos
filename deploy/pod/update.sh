#!/usr/bin/env bash
# Deploys new code from git on a pod that is already set up, WITHOUT changing the public addresses (the tunnels keep running):
# pull, install, build, apply database changes, restart the API, web and the two apps.  Run on the pod:
#   bash /workspace/medos-deploy/medos/deploy/pod/update.sh
set -euo pipefail
ROOT=/workspace/medos-deploy
SRC=$ROOT/medos
BRANCH=${MEDOS_BRANCH:-main}

git -C "$SRC" fetch -q origin "$BRANCH" && git -C "$SRC" reset -q --hard "origin/$BRANCH"
git -C "$SRC" log --oneline -1
cd "$SRC"
sed -i 's/\r$//' deploy/pod/*.sh; chmod +x deploy/pod/*.sh

# the AI host's own files (a change there needs its restart: bash deploy/pod/services.sh restart is not needed, only this copy and a host restart)
AI=/workspace/medos-ai
if ! cmp -s apps/ai-host/server.py "$AI/app/server.py" || ! cmp -s apps/ai-host/speech_prep.py "$AI/app/speech_prep.py" || ! cmp -s apps/ai-host/vlm_read.py "$AI/app/vlm_read.py"; then
  cp apps/ai-host/server.py apps/ai-host/speech_prep.py apps/ai-host/vlm_read.py "$AI/app/"
  echo "AI host files changed: restarting it (models reload, about a minute)"
  P=$(pgrep -f "uvicorn server:app --host 127.0.0.1 --port 8765" | head -1 || true); [ -n "$P" ] && kill "$P" || true
  sleep 2; (cd "$AI" && setsid nohup ./start.sh > logs/start.log 2>&1 < /dev/null &)
fi

pnpm install --frozen-lockfile >/dev/null
for p in database shared frontdesk-core; do pnpm --filter "@medos/$p" build >/dev/null; done
for a in api voicebot ocr-app web; do pnpm --filter "@medos/$a" build >/dev/null; done
export DATABASE_URL="postgresql://postgres:$(cat $ROOT/secrets/db-password)@127.0.0.1:5432/medos"
(cd packages/database && pnpm exec prisma migrate deploy 2>&1 | tail -n 2)
bash deploy/pod/services.sh reload
