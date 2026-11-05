# MedOS AI host

Prescription reading (OCR), speech recognition, spoken replies and the Hindi/English language model run **on a GPU server, never on the computer that runs MedOS**. MedOS calls one small web service (`server.py`) with one shared token.

Where it runs today: a **RunPod GPU pod** (RTX PRO 4500, 32 GB), reached through a private SSH tunnel. A free Kaggle notebook is the fallback (see the end).

| MedOS asks | Host does | Model |
|---|---|---|
| `POST /ocr` (picture or PDF) | reads the paper, handwriting included; a reading it cannot make out scores low so MedOS asks for a better photo instead of booking | `qwen2.5vl:7b` vision model (Apache-2.0) first, EasyOCR (Apache-2.0) as the fallback; PDFs with text use their text |
| `POST /asr` (short voice clip) | speech to text, Hindi or English | faster-whisper `large-v3` (MIT) |
| `POST /tts` (reply text) | speaks it, WAV | Meta MMS-TTS Hindi/English (**CC-BY-NC 4.0, non-commercial**) |
| `POST /api/chat` | Ollama pass-through: turns words into a structured request | `qwen2.5:14b` (Apache-2.0) |

MedOS never trusts these for facts. The model only decides what was *asked*; rates, doctors, free times and bookings always come from MedOS records (ADR-010).

## How it is wired

```
browser -> MedOS web -> MedOS API --(http://127.0.0.1:8765, SSH tunnel)--> pod 127.0.0.1:8765 (server.py) -> Ollama 127.0.0.1:11435
```

The host listens on the pod's loopback only, so nothing is exposed on a public address; the SSH tunnel (`scripts/ai-tunnel.ps1`) is only a pipe on the MedOS computer, no AI runs there. The bearer token is a second lock.

## Install on the pod (done once; repeat only on a new pod)

Everything goes under `/workspace/medos-ai` (the pod's persistent volume) and `/opt/medos-ai-venv`. Other projects on the pod are not touched; the host uses port 8765 and Ollama port 11435.

```bash
scp -P <port> -i <key> server.py root@<pod>:/workspace/medos-ai/app/server.py
scp -P <port> -i <key> pod/setup.sh pod/start.sh root@<pod>:/workspace/medos-ai/
ssh -p <port> -i <key> root@<pod> "cd /workspace/medos-ai && chmod +x *.sh && ./setup.sh"   # 15-25 min: packages and ~15 GB of models
ssh -p <port> -i <key> root@<pod> "cd /workspace/medos-ai && ./start.sh"
```

`start.sh` creates a random token on first run (`/workspace/medos-ai/token`, never printed in logs).

## Connect MedOS

1. `.local/pod.env` (not committed): `POD_HOST`, `POD_PORT`, `POD_KEY`.
2. `.local/ai-remote.env` (not committed): `AI_REMOTE_URL=http://127.0.0.1:8765`, `AI_REMOTE_TOKEN=<the pod's token>`, `ASSISTANT_LLM_MODEL=qwen2.5:14b`.
3. `scripts/ai-tunnel.ps1` (leave the window open), then `scripts/dev-api.ps1` and the web app.
4. `GET /api/v1/assistant/capabilities` shows `voice`, `speaking`, `prescriptionReading`, `model`.

`scripts/ai-pod.ps1` checks the host and starts it if the pod was restarted (the pod's own disk is reset on restart; `/workspace` is not, so `start.sh` and the cached models survive, and `setup.sh` rebuilds the Python environment from the pip cache in a few minutes).

## Read this before using it with real people

- **Patient data leaves the MedOS computer.** A prescription picture or a caller's voice goes through the SSH tunnel to a rented GPU server in a data centre. Use made-up patients until the privacy review (India's DPDP Act 2023, consent, a processing agreement with the provider) is done. For real use, run the same `server.py` on a server the hospital controls; MedOS changes only the URL.
- **Shared pod.** `/workspace` on this pod also holds another project. Do not delete or restart anything there; `setup.sh` and `start.sh` touch only `medos-ai`.
- **Text-to-speech licence.** MMS-TTS is non-commercial. Replace `/tts` with a commercially licensed Hindi voice before MedOS is sold or used in a paid service.
- **Accuracy is measured only on a few samples.** Whisper large-v3 read a synthetic Hindi sentence well (small spelling slips), EasyOCR read a printed English/Hindi prescription at about 65% confidence and dropped a digit ("after 1 week" became "after week", which MedOS sent to review instead of booking). Handwriting reads badly. MedOS never books from an unclear reading and always reads a booking back for a yes.
- A rented pod costs money while it runs; stop it from the RunPod console when not in use.

## Files

- `server.py` is the host (FastAPI). It keeps nothing: audio and pictures live in memory or a temp file for the length of one request.
- `pod/setup.sh`, `pod/start.sh` install and start it on the pod.
- `vlm_read.py` holds the prompt and clean-up for the vision-model reading (repeated lines dropped, confidence worked out from how much was unreadable). Tests: `python -m unittest apps/ai-host/test_vlm_read.py`. Set `OCR_ENGINE=easyocr` to switch the vision model off.
- `speech_prep.py` rewrites a reply before it is spoken, because the voices only know their own script: numbers become words (phone numbers digit by digit), "Dr." becomes "डॉक्टर", and English names (doctors, departments) are written in Devanagari by the local model once and remembered in `translit-cache.json`. The text MedOS shows is untouched. Tests: `python -m unittest apps/ai-host/test_speech_prep.py`.
- `build_notebook.py` and `medos_ai_kaggle.ipynb` run the same host on a free Kaggle GPU with a Cloudflare tunnel instead (needs a phone-verified Kaggle account, GPU T4 x2, Internet On; the notebook prints `AI_REMOTE_URL` and `AI_REMOTE_TOKEN` each start; sessions end after about 12 hours). Edit `server.py`, never the notebook.
- MedOS's side is tested against a stand-in that answers in the host's format (`apps/api/src/modules/assistant/remote.spec.ts`).
