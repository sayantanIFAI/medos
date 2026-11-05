"""
MedOS AI host. Runs on a free Kaggle GPU notebook (see README.md), NOT on the machine that runs MedOS.

One small web service that gives MedOS four things over HTTP, all behind one shared token:

    POST /ocr          picture or PDF in  -> {text, confidence 0-100, engine}      (EasyOCR, Hindi + English)
    POST /asr          voice clip in      -> {text, language, seconds}              (faster-whisper)
    POST /tts          {text, language}   -> audio/wav                              (Meta MMS-TTS; CC-BY-NC licence, see README)
    POST /api/chat     Ollama chat        -> passed through to the local Ollama     (Qwen2.5)
    GET  /health       what is loaded (no token needed, reveals nothing private)

Nothing is stored: every request is handled in memory or a temp file that is deleted straight away.
The host decides nothing about patients, doctors or bookings; MedOS does that. This only reads, listens, speaks and understands words.
"""
import io
import json
import os
import re
import secrets
import tempfile
import threading
import wave
from typing import Any, Optional

import httpx
from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool

from speech_prep import SpeechPrep
from vlm_read import PROMPT as VLM_PROMPT
from vlm_read import clean_reading

TOKEN = os.environ.get("MEDOS_AI_TOKEN", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
MAX_UPLOAD = 8 * 1024 * 1024
# Words a front desk says, so the speech model leans toward them. MedOS may send its own "prompt" with a request.
DEFAULT_HI_PROMPT = "डॉक्टर, अपॉइंटमेंट, बुकिंग, CBC, थायराइड, लिपिड प्रोफाइल, शुगर टेस्ट, कार्डियोलॉजी, कल सुबह"

app = FastAPI(title="MedOS AI host", docs_url=None, redoc_url=None, openapi_url=None)

_state: dict[str, Any] = {"ocr": None, "asr": None, "tts": {}, "errors": {}}
_locks = {"ocr": threading.Lock(), "asr": threading.Lock(), "tts": threading.Lock()}


def require_token(request: Request) -> None:
    """Every route except /health needs the shared token. The comparison does not leak how many characters matched."""
    if not TOKEN:
        raise HTTPException(503, "host has no token configured")
    given = request.headers.get("authorization", "")
    if not secrets.compare_digest(given.encode(), f"Bearer {TOKEN}".encode()):
        raise HTTPException(401, "unauthorised")


# ───────────────────────── models (loaded once, at start) ─────────────────────────

def _load_ocr() -> None:
    import easyocr  # noqa: PLC0415 - heavy import, only when the host starts

    try:
        _state["ocr"] = easyocr.Reader(["hi", "en"], gpu=True, verbose=False)
    except Exception:  # no GPU: slower, still works
        _state["ocr"] = easyocr.Reader(["hi", "en"], gpu=False, verbose=False)


def _load_asr() -> None:
    from faster_whisper import WhisperModel  # noqa: PLC0415

    try:
        _state["asr"] = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
    except Exception:  # no usable GPU libraries: fall back to the processor (much slower)
        _state["asr"] = WhisperModel("medium", device="cpu", compute_type="int8")


@app.on_event("startup")
def load_models() -> None:
    # the voices load at start too, so the first spoken reply after a restart is not the slow one
    for name, loader in (("ocr", _load_ocr), ("asr", _load_asr), ("tts", lambda: [_speak("नमस्ते", "hi"), _speak("hello", "en")])):
        try:
            loader()
        except Exception as e:  # one model failing must not take the others down
            _state["errors"][name] = f"{type(e).__name__}: {e}"[:300]


# ───────────────────────── health ─────────────────────────

@app.get("/health")
async def health() -> dict[str, Any]:
    llm = False
    try:
        async with httpx.AsyncClient(timeout=2) as c:
            llm = (await c.get(f"{OLLAMA_URL}/api/tags")).status_code == 200
    except Exception:
        llm = False
    return {"ok": True, "ocr": _state["ocr"] is not None, "asr": _state["asr"] is not None, "llm": llm, "tts": ["hi", "en"], "errors": _state["errors"]}


# ───────────────────────── OCR ─────────────────────────

def _group_lines(results: list[Any]) -> tuple[str, float]:
    """EasyOCR returns boxes; the prescription reader downstream works line by line, so boxes on one baseline are joined into one line."""
    items = []
    for box, text, conf in results:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        items.append({"x0": min(xs), "yc": sum(ys) / len(ys), "h": max(ys) - min(ys), "text": text.strip(), "conf": float(conf)})
    items = [i for i in items if i["text"]]
    if not items:
        return "", 0.0
    items.sort(key=lambda i: i["yc"])
    lines: list[list[dict[str, Any]]] = []
    for it in items:
        if lines:
            ref = lines[-1]
            ref_y = sum(i["yc"] for i in ref) / len(ref)
            ref_h = max(i["h"] for i in ref)
            if abs(it["yc"] - ref_y) <= 0.6 * max(ref_h, it["h"], 1):
                ref.append(it)
                continue
        lines.append([it])
    text = "\n".join(" ".join(i["text"] for i in sorted(ln, key=lambda i: i["x0"])) for ln in lines)
    weight = sum(len(i["text"]) for i in items)
    confidence = 100.0 * sum(i["conf"] * len(i["text"]) for i in items) / max(weight, 1)
    return text, confidence


def _prepare(image: Any) -> Any:
    from PIL import ImageOps  # noqa: PLC0415

    # a phone photo carries its rotation in metadata: without this a sideways paper is read as noise
    return ImageOps.exif_transpose(image).convert("RGB")


def _ocr_image(image: Any) -> tuple[str, float]:
    import numpy as np  # noqa: PLC0415

    image = _prepare(image)
    image.thumbnail((3000, 3000))
    with _locks["ocr"]:
        return _group_lines(_state["ocr"].readtext(np.array(image), detail=1, paragraph=False))


OCR_ENGINE = os.environ.get("OCR_ENGINE", "vlm")  # vlm: a vision model reads the paper (handwriting too); easyocr: the plain text finder
VLM_MODEL = os.environ.get("MEDOS_VLM_MODEL", "qwen2.5vl:7b")


def _vlm_page(image: Any) -> str:
    import base64  # noqa: PLC0415

    image = _prepare(image)
    image.thumbnail((2000, 2000))
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=90)
    body = {
        "model": VLM_MODEL, "stream": False, "keep_alive": "24h",
        "options": {"temperature": 0, "num_predict": 1400, "num_ctx": 8192, "repeat_penalty": 1.1},
        "messages": [{"role": "user", "content": VLM_PROMPT, "images": [base64.b64encode(buf.getvalue()).decode()]}],
    }
    with httpx.Client(timeout=170) as c:
        r = c.post(f"{OLLAMA_URL}/api/chat", json=body)
        r.raise_for_status()
    return str(r.json()["message"]["content"])


def _read(data: bytes, content_type: str) -> dict[str, Any]:
    from PIL import Image  # noqa: PLC0415

    if content_type == "application/pdf":
        from pypdf import PdfReader  # noqa: PLC0415

        text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages[:5]).strip()
        if len(text) > 20:  # a PDF with real text needs no reading
            return {"text": text, "confidence": 100, "engine": "pdf-text"}
        import pypdfium2 as pdfium  # noqa: PLC0415 - draws pages without any system package

        doc = pdfium.PdfDocument(data)
        images = [doc[index].render(scale=200 / 72).to_pil() for index in range(min(len(doc), 3))]
    else:
        images = [Image.open(io.BytesIO(data))]

    vlm: Optional[tuple[str, int]] = None
    if OCR_ENGINE == "vlm":
        try:
            vlm = clean_reading("\n".join(_vlm_page(im) for im in images))
            if vlm[1] >= 55 or _state["ocr"] is None:
                return {"text": vlm[0], "confidence": vlm[1], "engine": "qwen2.5-vl"}
        except Exception as e:  # the vision model is down or timed out: fall back to the plain text finder
            _state["errors"]["vlm"] = f"{type(e).__name__}: {e}"[:200]
    if _state["ocr"] is None:
        raise HTTPException(503, "reader not loaded")
    parts, confs = [], []
    for im in images:
        t, c = _ocr_image(im)
        parts.append(t)
        confs.append(c)
    easy = (round(sum(confs) / max(len(confs), 1)), "\n".join(parts))
    if vlm and vlm[1] >= easy[0]:  # the vision model read it badly too, but better
        return {"text": vlm[0], "confidence": vlm[1], "engine": "qwen2.5-vl"}
    return {"text": easy[1], "confidence": easy[0], "engine": "easyocr"}


@app.post("/ocr", dependencies=[Depends(require_token)])
async def ocr(request: Request) -> dict[str, Any]:
    data = await request.body()
    if not data or len(data) > MAX_UPLOAD:
        raise HTTPException(400, "send one picture or PDF, up to 8 MB")
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type not in ("image/png", "image/jpeg", "application/pdf"):
        raise HTTPException(415, "PNG, JPEG or PDF only")
    try:
        return await run_in_threadpool(_read, data, content_type)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(422, f"could not read the file ({type(e).__name__})") from e


# ───────────────────────── speech to text ─────────────────────────

_SUFFIX = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/aac": ".aac"}


def _transcribe(data: bytes, suffix: str, language: str, prompt: Optional[str]) -> dict[str, Any]:
    if _state["asr"] is None:
        raise HTTPException(503, "speech model not loaded")
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:  # deleted as soon as the block ends
        f.write(data)
        f.flush()
        with _locks["asr"]:
            segments, info = _state["asr"].transcribe(
                f.name, language=language, task="transcribe", beam_size=1, vad_filter=True,
                condition_on_previous_text=False, initial_prompt=prompt or (DEFAULT_HI_PROMPT if language == "hi" else None),
            )
            text = " ".join(s.text.strip() for s in segments).strip()
    if _repeats_prompt(text, prompt or (DEFAULT_HI_PROMPT if language == "hi" else None)):
        text = ""  # a short or unclear clip made the model read its own hint back: that is not what the caller said
    return {"text": text, "language": info.language, "seconds": round(float(info.duration), 2)}


def _repeats_prompt(text: str, prompt: Optional[str]) -> bool:
    squash = lambda s: re.sub(r"[\s,.;:!?।\-]+", "", s)  # noqa: E731
    t, p = squash(text), squash(prompt or "")
    if not t or not p:
        return False
    return (t in p and len(t) >= 0.6 * len(p)) or (len(p) >= 8 and p in t)


@app.post("/asr", dependencies=[Depends(require_token)])
async def asr(request: Request, language: str = "hi", prompt: Optional[str] = None) -> dict[str, Any]:
    if language not in ("hi", "en"):
        raise HTTPException(400, "language must be hi or en")
    data = await request.body()
    if not data or len(data) > MAX_UPLOAD:
        raise HTTPException(400, "send one short recording, up to 8 MB")
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type not in _SUFFIX:
        raise HTTPException(415, "audio only (webm, ogg, wav, mp4, mp3, aac)")
    try:
        return await run_in_threadpool(_transcribe, data, _SUFFIX[content_type], language, (prompt or "")[:400] or None)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(422, f"could not understand the recording ({type(e).__name__})") from e


# ───────────────────────── text to speech ─────────────────────────

_TTS_MODELS = {"hi": "facebook/mms-tts-hin", "en": "facebook/mms-tts-eng"}
TRANSLIT_MODEL = os.environ.get("MEDOS_TRANSLIT_MODEL", "qwen2.5:14b")
_TRANSLIT_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {"latin": {"type": "string"}, "hindi": {"type": "string"}}, "required": ["latin", "hindi"]}}},
    "required": ["items"],
}


def _translit(words: list[str]) -> dict[str, str]:
    """English words (doctor and department names) as they are pronounced in Hindi, written in Devanagari, by the local language model."""
    body = {
        "model": TRANSLIT_MODEL, "stream": False, "format": _TRANSLIT_SCHEMA, "keep_alive": "24h", "options": {"temperature": 0, "num_predict": 300},
        "messages": [
            {"role": "system", "content": "Write each English word in Devanagari exactly as a Hindi speaker pronounces it (for example Nandini -> नंदिनी, Roy -> रॉय, Paediatrics -> पीडियाट्रिक्स, Cardiology -> कार्डियोलॉजी). Return JSON with an items list of {latin, hindi}, one entry per word, in the same order. Devanagari letters only in hindi."},
            {"role": "user", "content": json.dumps(words, ensure_ascii=False)},
        ],
    }
    with httpx.Client(timeout=30) as c:
        r = c.post(f"{OLLAMA_URL}/api/chat", json=body)
        r.raise_for_status()
    items = json.loads(r.json()["message"]["content"]).get("items", [])
    return {str(i.get("latin", "")).lower(): str(i.get("hindi", "")) for i in items}


_prep = SpeechPrep(_translit, os.environ.get("TRANSLIT_CACHE", "translit-cache.json"))


def _speak(text: str, language: str) -> bytes:
    import numpy as np  # noqa: PLC0415
    import torch  # noqa: PLC0415
    from transformers import AutoTokenizer, VitsModel  # noqa: PLC0415

    text = _prep.prepare(text, language) or text  # numbers and English words rewritten so the voice can say them

    with _locks["tts"]:
        if language not in _state["tts"]:  # loaded the first time it is needed
            name = _TTS_MODELS[language]
            device = "cuda" if torch.cuda.is_available() else "cpu"
            _state["tts"][language] = (AutoTokenizer.from_pretrained(name), VitsModel.from_pretrained(name).to(device), device)
        tok, model, device = _state["tts"][language]
        inputs = tok(text, return_tensors="pt").to(device)
        with torch.no_grad():
            wave_out = model(**inputs).waveform[0].cpu().numpy()
        rate = int(model.config.sampling_rate)
    pcm = (np.clip(wave_out, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.post("/tts", dependencies=[Depends(require_token)])
async def tts(payload: dict[str, Any] = Body(...)) -> Response:
    text = str(payload.get("text", "")).strip()[:500]
    language = str(payload.get("language", "hi"))
    if not text or language not in _TTS_MODELS:
        raise HTTPException(400, "send text and a language of hi or en")
    try:
        return Response(content=await run_in_threadpool(_speak, text, language), media_type="audio/wav")
    except Exception as e:
        raise HTTPException(422, f"could not speak this ({type(e).__name__})") from e


# ───────────────────────── language model (Ollama, passed through) ─────────────────────────

@app.post("/api/chat", dependencies=[Depends(require_token)])
async def chat(request: Request) -> Response:
    body = await request.body()
    if len(body) > 200_000:
        raise HTTPException(413, "request too large")
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(f"{OLLAMA_URL}/api/chat", content=body, headers={"content-type": "application/json"})
    except httpx.HTTPError as e:
        raise HTTPException(503, "language model is not running") from e
    return Response(content=r.content, status_code=r.status_code, media_type="application/json")
