"""Tests de la mise en forme des résumés (sans modèle)."""

import unittest

from vt_server.summarizer import chunk_segments, parse_sections


class TestDecoupage(unittest.TestCase):
    def seg(self, words, start=0.0):
        return {"start": start, "end": start + 5, "en": " ".join(["mot"] * words), "fr": ""}

    def test_texte_court_un_seul_chapitre(self):
        self.assertEqual(len(chunk_segments([self.seg(50) for _ in range(10)])), 1)

    def test_chapitres_equilibres(self):
        # 1 400 mots : deux chapitres de ~700 mots, pas 1 300 + 100.
        chunks = chunk_segments([self.seg(100, i * 5) for i in range(14)], max_words=1300)
        sizes = [sum(len(s["en"].split()) for s in c) for c in chunks]
        self.assertEqual(len(chunks), 2)
        self.assertLessEqual(max(sizes) - min(sizes), 200)

    def test_aucun_segment_perdu(self):
        segs = [self.seg(37, i) for i in range(200)]
        chunks = chunk_segments(segs, max_words=1300)
        self.assertEqual(sum(len(c) for c in chunks), 200)


class TestLecture(unittest.TestCase):
    def test_format_attendu(self):
        r = parse_sections("TITRE : Arrivée au château\nRÉSUMÉ : Phrase un.\nPhrase deux.\nPOINTS :\n- A\n- B")
        self.assertEqual(r["titre"], "Arrivée au château")
        self.assertEqual(r["resume"], "Phrase un. Phrase deux.")
        self.assertEqual(r["points"], ["A", "B"])

    def test_intitules_variables_et_prefixes(self):
        r = parse_sections("Résumé : Texte.\n**Points importants :**\n1. Point 1 : premier\n2. Point 2 : second")
        self.assertEqual(r["resume"], "Texte.")
        self.assertEqual(r["points"], ["premier", "second"])

    def test_evenements_comptent_comme_points(self):
        r = parse_sections("RÉSUMÉ : X.\nÉvénements clés de l'histoire :\n- un\n- deux")
        self.assertEqual(r["points"], ["un", "deux"])


if __name__ == "__main__":
    unittest.main()
