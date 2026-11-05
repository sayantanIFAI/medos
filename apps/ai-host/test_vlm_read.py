"""Run with:  python -m unittest apps/ai-host/test_vlm_read.py   (no GPU or model needed)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from vlm_read import clean_reading  # noqa: E402

GOOD = "City Child Clinic\nDr. Nandini Roy, MD (Paediatrics)\nPatient: Tapan Das Age: 6\n1. Syp Paracetamol 5 ml thrice daily\nInvestigations: CBC, Lipid Profile, HbA1c\nथायराइड जांच भी करवाएं\nFollow up after 1 week."


class CleanReadingTest(unittest.TestCase):
    def test_a_clear_reading_keeps_its_text_and_scores_high(self):
        text, conf = clean_reading(GOOD)
        self.assertEqual(text, GOOD)
        self.assertGreaterEqual(conf, 85)

    def test_a_loop_of_unreadable_markers_is_dropped_and_scores_low(self):
        text, conf = clean_reading("DR. P K HAZRA\nApollo Clinic\n" + "[?]\n" * 300)
        self.assertEqual(text, "DR. P K HAZRA\nApollo Clinic")
        self.assertLess(conf, 55, "too little was read to book from")

    def test_a_few_unreadable_words_lower_the_score_a_little(self):
        text, conf = clean_reading(GOOD + "\nTab [?] 10 mg at night")
        self.assertIn("[?]", text)
        self.assertGreaterEqual(conf, 55)
        self.assertLess(conf, clean_reading(GOOD)[1])

    def test_repeated_lines_are_collapsed(self):
        text, conf = clean_reading("Lipid Profile\n" * 40 + "CBC today please\nHbA1c test advised\nTSH thyroid test\nFollow up soon")
        self.assertEqual(text.count("Lipid Profile"), 1)

    def test_nothing_read_is_zero(self):
        self.assertEqual(clean_reading("")[1], 0)
        self.assertLessEqual(clean_reading("[?]\n[?]")[1], 30)


if __name__ == "__main__":
    unittest.main()
