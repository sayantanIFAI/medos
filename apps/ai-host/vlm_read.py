"""
Reading a photographed prescription with a vision-language model (Qwen2.5-VL on the pod). It reads handwriting and dense printed forms far
better than a plain text finder, but it gives no confidence of its own and can loop on "[?]" when a picture is too small or blurry to read.
This module holds the prompt and the clean-up: repeated lines are dropped and a confidence is worked out from how much it could not read,
so MedOS (which never books from a reading under 55%) still knows when to ask for a better photo.
"""
import re

PROMPT = (
    "You are reading a photographed medical prescription (printed or handwritten; English and/or Hindi). Transcribe ALL the text exactly as "
    "written, line by line, in reading order: clinic and doctor names, patient name, age and date, drug names with doses and timings, lab "
    "tests and investigations, advice and follow-up. Keep Hindi in Devanagari and English in English. Do not explain, translate, summarise "
    "or repeat yourself. Write [?] for a single word you cannot read; if a line is entirely unreadable, skip it."
)

_UNREADABLE = "[?]"


def clean_reading(raw: str) -> tuple[str, int]:
    """Returns (text, confidence 0..100). Repeated lines and runs of unreadable markers are collapsed first."""
    lines: list[str] = []
    unreadable = 0
    repeats = 0
    for line in raw.splitlines():
        s = line.strip()
        if not s:
            continue
        n_bad = s.count(_UNREADABLE)
        if n_bad and not s.replace(_UNREADABLE, "").strip(" .,;:-|"):
            unreadable += n_bad  # a line of nothing but "[?]" says only that something was there
            continue
        if lines and s == lines[-1]:
            repeats += 1
            continue
        unreadable += n_bad
        lines.append(s)
    text = "\n".join(lines)
    words = re.findall(r"[\wऀ-ॿ]{2,}", text.replace(_UNREADABLE, " "))
    total = len(words) + unreadable
    ratio = unreadable / total if total else 1.0
    confidence = round(92 - 130 * ratio - 3 * min(repeats, 5))
    if len(words) < 5:
        confidence = min(confidence, 30)
    return text, max(0, min(100, confidence))
