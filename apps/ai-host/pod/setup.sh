#!/usr/bin/env bash
# One-time (and safe to repeat) install of the MedOS AI host on a RunPod GPU pod.
# Everything lives under /workspace/medos-ai (the pod's persistent volume) or /opt/medos-ai-venv (rebuilt from the pip cache if the pod's
# disk was reset). Nothing else on the pod is touched: other projects' folders, venvs, ports and GPU jobs are left alone.
set -euo pipefail

BASE=/workspace/medos-ai
VENV=/opt/medos-ai-venv
OLLAMA_DIST=$BASE/ollama-dist
MODEL=${ASSISTANT_LLM_MODEL:-qwen2.5:14b}

mkdir -p "$BASE"/{app,logs,ollama-models,hf,pip-cache}
export PIP_CACHE_DIR=$BASE/pip-cache

echo "== python environment"
if [ ! -x "$VENV/bin/python" ]; then python3 -m venv "$VENV"; fi
"$VENV/bin/pip" install -q -U pip wheel
"$VENV/bin/pip" install -q fastapi "uvicorn[standard]" httpx easyocr faster-whisper transformers pypdf pypdfium2 pillow numpy "av>=14,<17"
# Blackwell GPUs (RTX PRO 4500) need a PyTorch built for CUDA 12.8 or newer. torch and torchaudio must come as a matching pair from the
# same build (other packages pull a different CUDA build of torch and break torchaudio), so this runs last.
if ! "$VENV/bin/python" -c "import torch,torchaudio,sys; sys.exit(0 if torch.cuda.is_available() and torch.version.cuda.startswith('12.8') else 1)" 2>/dev/null; then
  "$VENV/bin/pip" install -q --force-reinstall torch torchaudio --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple
fi

echo "== language model server (Ollama, private copy)"
if [ ! -x "$OLLAMA_DIST/bin/ollama" ]; then
  mkdir -p "$OLLAMA_DIST"
  curl -fsSL https://ollama.com/download/ollama-linux-amd64.tar.zst | zstd -d | tar -x -C "$OLLAMA_DIST"
fi
if ! pgrep -f "$OLLAMA_DIST/bin/ollama serve" >/dev/null; then
  OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS=$BASE/ollama-models OLLAMA_KEEP_ALIVE=24h \
    nohup "$OLLAMA_DIST/bin/ollama" serve >"$BASE/logs/ollama.log" 2>&1 &
  sleep 6
fi
OLLAMA_HOST=127.0.0.1:11435 "$OLLAMA_DIST/bin/ollama" pull "$MODEL"

echo "== download speech, reading and voice models (cached under $BASE/hf)"
export HF_HOME=$BASE/hf EASYOCR_MODULE_PATH=$BASE/hf/easyocr
"$VENV/bin/python" - <<'PY'
import easyocr
from faster_whisper import WhisperModel
from transformers import AutoTokenizer, VitsModel
easyocr.Reader(["hi", "en"], gpu=False, verbose=False)
WhisperModel("large-v3", device="cpu", compute_type="int8")
for name in ("facebook/mms-tts-hin", "facebook/mms-tts-eng"):
    AutoTokenizer.from_pretrained(name); VitsModel.from_pretrained(name)
print("models cached")
PY
echo "setup finished"
