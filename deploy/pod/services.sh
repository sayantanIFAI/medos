#!/usr/bin/env bash
# Starts, stops or shows the MedOS processes on the pod:  services.sh start|stop|restart|status|urls
# Only processes of this deployment are touched (matched by their exact command line under /workspace/medos-deploy), never other projects'.
set -uo pipefail

ROOT=/workspace/medos-deploy
SRC=$ROOT/medos
SECRETS=$ROOT/secrets
LOGS=$ROOT/logs
AI=/workspace/medos-ai
PGBIN=/usr/lib/postgresql/16/bin
mkdir -p "$LOGS"

# a copy of the database on the volume (the database itself lives on the pod's disk), so a recreated pod can be restored
backup_db() {
  mkdir -p "$ROOT/backup"
  PGPASSWORD=$(cat "$SECRETS/db-password") pg_dump -h 127.0.0.1 -U postgres medos > "$ROOT/backup/medos.sql.new" 2>/dev/null && mv "$ROOT/backup/medos.sql.new" "$ROOT/backup/medos.sql" || rm -f "$ROOT/backup/medos.sql.new"
}

mine() { pgrep -f "$1" | grep -v "^$$\$" || true; }

stop() {
  for pat in "$SRC/apps/api/dist/main.js" "$SRC/apps/voicebot/dist/main.js" "$SRC/apps/ocr-app/dist/main.js" "next start -p 3000" "cloudflared tunnel --no-autoupdate --url http://127.0.0.1"; do
    for p in $(mine "$pat"); do kill "$p" 2>/dev/null; done
  done
  sleep 1
}

tunnel() { # name port -> starts a quick tunnel and waits for its public address
  local name=$1 port=$2
  : > "$LOGS/tunnel-$name.log"
  (setsid nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port" > "$LOGS/tunnel-$name.log" 2>&1 < /dev/null &)
  for i in $(seq 1 40); do
    u=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOGS/tunnel-$name.log" | head -1)
    [ -n "$u" ] && { echo "$u"; return; }
    sleep 1
  done
}

start() {
  DB_PASSWORD=$(cat "$SECRETS/db-password")
  su postgres -c "$PGBIN/pg_isready -q -h 127.0.0.1 -p 5432" || su postgres -c "$PGBIN/pg_ctl -D /var/lib/medos-pgdata -o '-p 5432 -c listen_addresses=127.0.0.1' -l $LOGS/postgres.log -w start" >/dev/null
  backup_db
  (cd "$AI" && curl -s -m 3 http://127.0.0.1:8765/health >/dev/null || (setsid nohup ./start.sh > logs/start.log 2>&1 < /dev/null &))

  # load the language model and the vision model into the GPU now, so the first person to use them does not wait a minute
  (for m in qwen2.5:14b qwen2.5vl:7b; do curl -s -m 180 http://127.0.0.1:11435/api/generate -d "{\"model\":\"$m\",\"keep_alive\":\"24h\",\"prompt\":\"\"}" > /dev/null; done &) 2>/dev/null

  AI_TOKEN=$(cat "$AI/token" 2>/dev/null || true)
  (set -a; . "$ROOT/api.env"; set +a; export AI_REMOTE_TOKEN=$AI_TOKEN; cd "$SRC"; setsid nohup node apps/api/dist/main.js > "$LOGS/api.log" 2>&1 < /dev/null &)
  (cd "$SRC/apps/web" && API_URL=http://127.0.0.1:4000/api/v1 setsid nohup pnpm exec next start -p 3000 > "$LOGS/web.log" 2>&1 < /dev/null &)

  # public addresses first, so the apps can link to the web app
  WEB=$(tunnel web 3000); VB=$(tunnel voicebot 5101); OCR=$(tunnel ocr 5102)
  echo "$WEB" > "$ROOT/url-web"; echo "$VB" > "$ROOT/url-voicebot"; echo "$OCR" > "$ROOT/url-ocr"

  APP_PASS=$(sed -n 's/^password: //p' "$SECRETS/login.txt")
  for app in voicebot:5101 ocr-app:5102; do
    n=${app%%:*}; p=${app##*:}
    envfile=$SRC/.local/$( [ "$n" = voicebot ] && echo voicebot.env || echo ocr-app.env )
    (set -a; . "$envfile"; set +a
     export MEDOS_WEB_URL=$WEB AI_URL=http://127.0.0.1:8765 AI_TOKEN=$AI_TOKEN APP_BIND=127.0.0.1 APP_ALLOWED_HOSTS=.trycloudflare.com APP_BASIC_AUTH="reception1:$APP_PASS"
     cd "$SRC"; setsid nohup node "apps/$n/dist/main.js" > "$LOGS/$n.log" 2>&1 < /dev/null &)
  done
  sleep 6
  status
}

status() {
  echo "AI host:   $(curl -s -m 5 http://127.0.0.1:8765/health || echo down)"
  echo "API:       $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/v1/nothing)  (404 = running)"
  echo "web:       $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login)"
  echo "voicebot:  $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:5101/)  (401 = running, asks for login)"
  echo "OCR:       $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:5102/)  (401 = running, asks for login)"
  urls
}

urls() {
  echo "web:       $(cat "$ROOT/url-web" 2>/dev/null)"
  echo "voicebot:  $(cat "$ROOT/url-voicebot" 2>/dev/null)"
  echo "OCR:       $(cat "$ROOT/url-ocr" 2>/dev/null)"
}

case "${1:-status}" in
  start) start ;;
  stop) backup_db; stop ;;
  backup) backup_db ;;
  restart) stop; start ;;
  status) status ;;
  urls) urls ;;
  *) echo "usage: services.sh start|stop|restart|status|urls"; exit 2 ;;
esac
