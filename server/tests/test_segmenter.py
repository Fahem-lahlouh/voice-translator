"""Tests du découpage de la parole (hors modèle : VAD simulé)."""

import unittest

import numpy as np

from vt_server.segmenter import FRAME, FRAME_S, Segmenter


class FauxVad:
    """Détecteur simulé : la probabilité est l'amplitude de la trame.

    Permet de tester la logique de découpage de façon déterministe, sans
    dépendre du modèle Silero (testé, lui, par les essais de bout en bout).
    """

    def reset(self):
        pass

    def probs(self, frames):
        return np.clip(np.abs(frames).max(axis=1), 0, 1).astype(np.float32)


def signal(*blocs):
    """bloc = (niveau, durée en secondes) -> échantillons float32."""
    out = []
    for niveau, duree in blocs:
        n = int(round(duree / FRAME_S)) * FRAME
        out.append(np.full(n, niveau, dtype=np.float32))
    return np.concatenate(out)


class TestDecoupage(unittest.TestCase):
    def seg(self, **kw):
        params = dict(threshold=0.5, min_silence_s=0.4, soft_max_s=5.0,
                      hard_max_s=8.0, min_speech_s=0.2)
        params.update(kw)
        return Segmenter(FauxVad(), **params)

    def test_silence_seul_ne_produit_rien(self):
        s = self.seg()
        self.assertEqual(s.feed(signal((0.0, 5.0))), [])
        self.assertIsNone(s.finish())

    def test_une_phrase_isolee(self):
        s = self.seg()
        segs = s.feed(signal((0.0, 0.5), (0.9, 2.0), (0.0, 2.0)))
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0].end, "pause")
        self.assertGreater(segs[0].speech_s, 1.5)
        # Le pré-enregistrement démarre un peu avant la parole.
        self.assertLess(segs[0].t0, 0.5)

    def test_deux_phrases_separees(self):
        s = self.seg()
        segs = s.feed(signal((0.0, 0.3), (0.9, 1.5), (0.0, 2.0), (0.9, 1.5), (0.0, 2.0)))
        self.assertEqual(len(segs), 2)
        self.assertLess(segs[0].t1, segs[1].t0)  # aucun recouvrement

    def test_pas_de_coupe_sur_micro_silence(self):
        s = self.seg(min_silence_s=0.6)
        segs = s.feed(signal((0.9, 1.5), (0.0, 0.2), (0.9, 1.5), (0.0, 2.5)))
        self.assertEqual(len(segs), 1, "un silence de 0,2 s ne doit pas couper la phrase")

    def test_coupe_forcee_si_personne_ne_s_arrete(self):
        s = self.seg(hard_max_s=4.0)
        segs = s.feed(signal((0.9, 12.0)))
        self.assertGreaterEqual(len(segs), 2)
        self.assertTrue(all(x.end == "forcee" for x in segs))
        for a, b in zip(segs, segs[1:]):
            self.assertAlmostEqual(a.t1, b.t0, places=2, msg="les segments doivent être contigus")

    def test_coupe_forcee_preferee_dans_un_creux(self):
        # Parole forte, petit creux à 3,0 s, puis parole : la coupe doit tomber
        # dans le creux plutôt qu'au couperet des 4 s.
        s = self.seg(hard_max_s=4.0, min_silence_s=2.0)
        segs = s.feed(signal((0.9, 3.0), (0.2, 0.2), (0.9, 2.0), (0.0, 3.0)))
        self.assertGreaterEqual(len(segs), 1)
        self.assertAlmostEqual(segs[0].t1, 3.2, delta=0.4)

    def test_segment_trop_court_ignore(self):
        s = self.seg(min_speech_s=0.5)
        segs = s.feed(signal((0.0, 0.3), (0.9, 0.15), (0.0, 2.0)))
        self.assertEqual(segs, [])

    def test_finish_clot_le_segment_ouvert(self):
        s = self.seg()
        self.assertEqual(s.feed(signal((0.9, 2.0))), [])
        seg = s.finish()
        self.assertIsNotNone(seg)
        self.assertEqual(seg.end, "fin")
        self.assertIsNone(s.finish(), "une seconde clôture ne doit rien renvoyer")

    def test_reset_remet_l_horloge_a_zero(self):
        s = self.seg()
        s.feed(signal((0.9, 2.0), (0.0, 2.0)))
        self.assertGreater(s.clock_s, 3.0)
        s.reset()
        self.assertEqual(s.clock_s, 0.0)
        self.assertFalse(s.in_speech)

    def test_echantillons_partiels_conserves(self):
        s = self.seg()
        bruit = np.full(FRAME // 2, 0.9, dtype=np.float32)
        s.feed(bruit)
        s.feed(bruit)
        self.assertGreater(s.clock_s, 0.0)

    def test_silence_exige_plus_long_pour_un_segment_court(self):
        s = self.seg(min_silence_s=0.4, soft_max_s=5.0)
        self.assertGreater(s._required_silence(1.0), s._required_silence(6.0))
        self.assertGreaterEqual(s._required_silence(12.0), 0.1)


if __name__ == "__main__":
    unittest.main()
