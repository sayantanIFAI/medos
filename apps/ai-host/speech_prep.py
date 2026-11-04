"""
Makes a reply speakable. The Hindi and English voices (Meta MMS-TTS) only know the letters of their own script: digits and words in another
script are dropped or come out as noise. A reply such as "मोबाइल 9222222229। Dr. Nandini Roy (Paediatrics), सुबह 10:15 बजे" is therefore
rewritten before it is spoken:

    numbers       -> number words ("छह", digits one by one for phone numbers, "दस पंद्रह" for 10:15)
    "Dr."         -> "डॉक्टर"
    English words -> Devanagari as they are pronounced ("Nandini Roy" -> "नंदिनी रॉय"), written by the local language model once and then remembered
    brackets      -> pauses

Only the sound changes; the text MedOS shows on screen is never touched.
"""
import json
import os
import re
from typing import Callable, Optional

HI_ONES = ["शून्य", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ"]
HI_10_99 = (
    "दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस "
    "चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन "
    "तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर "
    "पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे "
    "पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे"
).split()
EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

Translit = Callable[[list[str]], dict[str, str]]


def _hi_number(n: int) -> str:
    return HI_ONES[n] if n < 10 else HI_10_99[n - 10]


def _en_number(n: int) -> str:
    if n < 20:
        return EN_ONES[n]
    return EN_TENS[n // 10] + ("" if n % 10 == 0 else " " + EN_ONES[n % 10])


def _digits(s: str, lang: str) -> str:
    words = HI_ONES if lang == "hi" else EN_ONES
    return " ".join(words[int(c)] for c in s)


def _number_words(run: str, lang: str) -> str:
    """Phone-like runs digit by digit (ten digits as 5 + 5, with a pause); short numbers as number words."""
    if len(run) >= 10:
        mid = len(run) // 2
        return _digits(run[:mid], lang) + ", " + _digits(run[mid:], lang)
    if len(run) >= 4 or (len(run) > 1 and run[0] == "0"):
        return _digits(run, lang)
    n = int(run)
    return (_hi_number(n) if lang == "hi" else _en_number(n))


def spell_numbers(text: str, lang: str) -> str:
    def clock(m: re.Match) -> str:
        h, mn = int(m.group(1)), int(m.group(2))
        say = _hi_number if lang == "hi" else _en_number
        return say(h) if mn == 0 else f"{say(h)} {say(mn)}"

    text = re.sub(r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)", clock, text)
    text = re.sub(r"(?<=\d),(?=\d)", "", text)  # 1,500 -> 1500
    text = re.sub(r"[₹]\s*", "", text)
    return re.sub(r"\d+", lambda m: _number_words(m.group(0), lang), text)


_LATIN = re.compile(r"[A-Za-z][A-Za-z'\-]*")


def latin_words(text: str) -> list[str]:
    return sorted({w.lower() for w in _LATIN.findall(text.replace("Dr.", " "))})


class SpeechPrep:
    """Rewrites a reply so the voice can say it. `translit` turns a list of English words into Devanagari (the local model); results are cached on disk."""

    def __init__(self, translit: Optional[Translit] = None, cache_file: Optional[str] = None) -> None:
        self.translit = translit
        self.cache_file = cache_file
        self.cache: dict[str, str] = {}
        if cache_file and os.path.exists(cache_file):
            try:
                with open(cache_file, encoding="utf-8") as f:
                    self.cache = json.load(f)
            except (OSError, ValueError):
                self.cache = {}

    def _remember(self) -> None:
        if not self.cache_file:
            return
        try:
            tmp = self.cache_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.cache, f, ensure_ascii=False, indent=0)
            os.replace(tmp, self.cache_file)
        except OSError:
            pass

    def prepare(self, text: str, lang: str) -> str:
        out = re.sub(r"\bDr\.?(?=\s)", "डॉक्टर" if lang == "hi" else "doctor", text)
        out = out.replace("(", ", ").replace(")", ", ")
        out = spell_numbers(out, lang)
        if lang == "hi":
            words = latin_words(out)
            missing = [w for w in words if w not in self.cache]
            if missing and self.translit:
                try:
                    got = self.translit(missing)
                    for w in missing:
                        d = (got.get(w) or "").strip()
                        if d and re.search(r"[ऀ-ॿ]", d) and not _LATIN.search(d):
                            self.cache[w] = d
                    self._remember()
                except Exception:  # the model is a helper: without it the English words are simply left out of the speech
                    pass
            out = _LATIN.sub(lambda m: self.cache.get(m.group(0).lower(), ""), out)
        out = re.sub(r"\s*,(\s*,)+", ",", out)
        out = re.sub(r"\s+,", ",", out)
        return re.sub(r"\s+", " ", out).strip(" ,")
