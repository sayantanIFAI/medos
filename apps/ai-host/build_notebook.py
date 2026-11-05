"""Builds medos_ai_kaggle.ipynb from server.py, so the notebook you upload to Kaggle always carries the current server.

    python build_notebook.py
"""
import json
from pathlib import Path

here = Path(__file__).parent
server = (here / "server.py").read_text(encoding="utf-8")
speech_prep = (here / "speech_prep.py").read_text(encoding="utf-8")
vlm_read = (here / "vlm_read.py").read_text(encoding="utf-8")


def md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip().splitlines(keepends=True)}


def code(text: str) -> dict:
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text.strip().splitlines(keepends=True)}


cells = [
    md("""
# MedOS AI host

Runs prescription reading (OCR), speech recognition, spoken replies and the Hindi/English language model for MedOS, on Kaggle's free GPU,
so none of it runs on the hospital computer.

**Before you run it:** Settings (right panel) -> *Accelerator*: **GPU T4 x2** (or P100), *Internet*: **On**, *Persistence*: no files.
Then **Run All**. At the end it prints two lines, `AI_REMOTE_URL` and `AI_REMOTE_TOKEN`. Paste them into MedOS (`.local/ai-remote.env`) and restart the MedOS API.

The address and token change every time this notebook is started. Keep this tab open: when the notebook stops, MedOS says the AI service is not connected.
Use it with made-up (demo) patients only until the privacy review in MedOS's REMINDER.md is done.
"""),
    code("""
# 1. Tools the host needs (about 2-3 minutes)
!apt-get -qq update > /dev/null && apt-get -qq install -y zstd poppler-utils > /dev/null
!pip -q install fastapi "uvicorn[standard]" httpx easyocr faster-whisper pypdf pdf2image transformers scipy
"""),
    code("""
# 2. The language model server (Ollama) and the Hindi-capable model
LLM_MODEL = "qwen2.5:7b"
!curl -fsSL https://ollama.com/install.sh | sh
import subprocess, time
ollama = subprocess.Popen(["ollama", "serve"], stdout=open("/kaggle/working/ollama.log", "w"), stderr=subprocess.STDOUT)
time.sleep(8)
!ollama pull {LLM_MODEL}
"""),
    code("%%writefile /kaggle/working/speech_prep.py\n" + speech_prep),
    code("%%writefile /kaggle/working/server.py\n" + server),
    code("""
# 3. Start the host. A new secret token is made each time; it is printed at the end and nowhere else.
import os, secrets, subprocess, sys, time, urllib.request, json
TOKEN = secrets.token_urlsafe(32)
env = dict(os.environ, MEDOS_AI_TOKEN=TOKEN, OLLAMA_URL="http://127.0.0.1:11434", WHISPER_MODEL="large-v3")
host = subprocess.Popen([sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8000"],
                        cwd="/kaggle/working", env=env, stdout=open("/kaggle/working/host.log", "w"), stderr=subprocess.STDOUT)
health = {}
for _ in range(180):  # the first start downloads the speech and reading models: up to ~15 minutes
    try:
        health = json.load(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3))
        if health["ocr"] and health["asr"]:
            break
    except Exception:
        pass
    time.sleep(5)
print("host:", health)
"""),
    code("""
# 4. Open a public address for it (a free Cloudflare quick tunnel; no account needed)
import re
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /kaggle/working/cloudflared && chmod +x /kaggle/working/cloudflared
tunnel = subprocess.Popen(["/kaggle/working/cloudflared", "tunnel", "--url", "http://127.0.0.1:8000", "--no-autoupdate"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
url = None
for line in tunnel.stdout:
    m = re.search(r"https://[a-z0-9-]+\\.trycloudflare\\.com", line)
    if m:
        url = m.group(0)
        break
import threading
threading.Thread(target=lambda: [None for _ in tunnel.stdout], daemon=True).start()  # keep reading its log so it never blocks
print()
print("Paste these two lines into MedOS  (.local/ai-remote.env)  and restart the MedOS API:")
print()
print("AI_REMOTE_URL=" + str(url))
print("AI_REMOTE_TOKEN=" + TOKEN)
"""),
    code("""
# 5. Keep the notebook running. Stop this cell (square button) to shut the host down.
while True:
    time.sleep(300)
    try:
        print(time.strftime("%H:%M"), json.load(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5)))
    except Exception as e:
        print(time.strftime("%H:%M"), "host not answering:", e)
"""),
]

nb = {
    "cells": cells,
    "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}},
    "nbformat": 4,
    "nbformat_minor": 5,
}
out = here / "medos_ai_kaggle.ipynb"
out.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
print("wrote", out)
