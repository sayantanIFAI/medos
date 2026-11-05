#!/usr/bin/env bash
# Starts (or restarts) the MedOS AI host on the pod. It listens on 127.0.0.1 only: MedOS reaches it through the SSH tunnel
# (scripts/ai-tunnel.ps1), so no patient data crosses a public address.
set -euo pipefail

BASE=/workspace/medos-ai
VENV=/opt/medos-ai-venv
PORT=${MEDOS_AI_PORT:-8765}
OLLAMA_DIST=$BASE/ollama-dist
MODEL=${ASSISTANT_LLM_MODEL:-qwen2.5:14b}

# a token that stays the same across restarts, kept only on the pod and in MedOS's .local folder
mkdir -p "$BASE/logs"
if [ ! -s "$BASE/token" ]; then head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$BASE/token"; chmod 600 "$BASE/token"; fi

if ! pgrep -f "$OLLAMA_DIST/bin/ollama serve" >/dev/null; then
  OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS=$BASE/ollama-models OLLAMA_KEEP_ALIVE=24h OLLAMA_CONTEXT_LENGTH=8192 OLLAMA_MAX_LOADED_MODELS=3 \
    nohup "$OLLAMA_DIST/bin/ollama" serve >>"$BASE/logs/ollama.log" 2>&1 &
  sleep 5
fi

pkill -f "uvicorn server:app --host 127.0.0.1 --port $PORT" 2>/dev/null || true
sleep 1

# CUDA libraries that PyTorch brought along, so the speech engine finds them
LIBS=$(ls -d "$VENV"/lib/python*/site-packages/nvidia/*/lib 2>/dev/null | tr '\n' ':')
export LD_LIBRARY_PATH="${LIBS}${LD_LIBRARY_PATH:-}"
export HF_HOME=$BASE/hf EASYOCR_MODULE_PATH=$BASE/hf/easyocr
export MEDOS_AI_TOKEN=$(cat "$BASE/token")
export OLLAMA_URL=http://127.0.0.1:11435
export TRANSLIT_CACHE=$BASE/translit-cache.json
export WHISPER_MODEL=large-v3

cd "$BASE/app"
nohup "$VENV/bin/uvicorn" server:app --host 127.0.0.1 --port "$PORT" --timeout-keep-alive 120 >>"$BASE/logs/host.log" 2>&1 &
echo "started on 127.0.0.1:$PORT (model $MODEL)"
