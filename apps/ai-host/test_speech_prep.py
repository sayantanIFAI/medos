"""Run with:  python -m unittest apps/ai-host/test_speech_prep.py   (no GPU or model needed: the translator is a stand-in)."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from speech_prep import SpeechPrep, latin_words, spell_numbers  # noqa: E402

FAKE = {"nandini": "नंदिनी", "roy": "रॉय", "paediatrics": "पीडियाट्रिक्स"}


def fake_translit(words):
    return {w: FAKE[w] for w in words if w in FAKE}


class SpeechPrepTest(unittest.TestCase):
    def test_numbers_become_hindi_words(self):
        self.assertEqual(spell_numbers("उम्र 6", "hi"), "उम्र छह")
        self.assertEqual(spell_numbers("5 नवंबर", "hi"), "पाँच नवंबर")
        self.assertEqual(spell_numbers("कुल ₹1,500", "hi"), "कुल एक पाँच शून्य शून्य")  # amounts are read digit by digit
        self.assertEqual(spell_numbers("सुबह 10:15 बजे", "hi"), "सुबह दस पंद्रह बजे")
        self.assertEqual(spell_numbers("8:00", "hi"), "आठ")

    def test_a_phone_number_is_read_digit_by_digit_in_two_halves(self):
        self.assertEqual(spell_numbers("मोबाइल 9222222229", "hi"), "मोबाइल नौ दो दो दो दो, दो दो दो दो नौ")
        self.assertEqual(spell_numbers("mobile 9830012345", "en"), "mobile nine eight three zero zero, one two three four five")
        self.assertEqual(spell_numbers("age 45", "en"), "age forty five")

    def test_the_reply_from_the_voicebot_is_fully_speakable(self):
        p = SpeechPrep(fake_translit)
        said = p.prepare("पक्का कर लूँ? मरीज़ बच्चे, उम्र 6, मोबाइल 9222222229। Dr. Nandini Roy (Paediatrics), कल (गुरुवार, 5 नवंबर), सुबह 10:15 बजे। बुक करूँ?", "hi")
        self.assertNotRegex(said, r"[A-Za-z0-9()]")
        for part in ["डॉक्टर नंदिनी रॉय", "पीडियाट्रिक्स", "उम्र छह", "नौ दो दो दो दो, दो दो दो दो नौ", "पाँच नवंबर", "सुबह दस पंद्रह बजे"]:
            self.assertIn(part, said)

    def test_without_the_model_english_words_are_left_out_not_garbled(self):
        said = SpeechPrep(None).prepare("Dr. Nandini Roy, कल सुबह", "hi")
        self.assertEqual(said, "डॉक्टर, कल सुबह")

    def test_a_translator_that_fails_or_answers_in_latin_letters_is_ignored(self):
        def broken(_):
            raise RuntimeError("model down")

        self.assertNotRegex(SpeechPrep(broken).prepare("Dr. Roy", "hi"), r"[A-Za-z]")
        self.assertNotRegex(SpeechPrep(lambda w: {x: "Roy" for x in w}).prepare("Dr. Roy", "hi"), r"[A-Za-z]")

    def test_names_are_asked_once_and_remembered_on_disk(self):
        calls = []

        def counting(words):
            calls.append(list(words))
            return fake_translit(words)

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "cache.json")
            SpeechPrep(counting, path).prepare("Dr. Nandini Roy", "hi")
            SpeechPrep(counting, path).prepare("Dr. Nandini Roy", "hi")  # a new process, same cache file
            self.assertEqual(len(calls), 1)

    def test_english_replies_only_get_their_numbers_spelled(self):
        self.assertEqual(SpeechPrep(None).prepare("Dr. Roy at 10:15, ref 4", "en"), "doctor Roy at ten fifteen, ref four")
        self.assertEqual(latin_words("Dr. Nandini Roy"), ["nandini", "roy"])


if __name__ == "__main__":
    unittest.main()
