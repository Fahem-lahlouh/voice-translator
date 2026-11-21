"""Tests des mécanismes de faible latence (sans moteur d'IA)."""

import threading
import time
import unittest

import numpy as np

from vt_server.config import Config
from vt_server.engines import trim_silence
from vt_server.pipeline import Session, Settings, _TtsItem


class FauxMoteurs:
    def __init__(self):
        self.ready = threading.Event()
        self.bascules = 0

    def downgrade_asr(self, on_done=None):
        self.bascules += 1
        return True


def session(**cfg):
    s = Session(FauxMoteurs(), Config(**cfg).resolved(), lambda o: None, lambda b: None)
    s.start(1, Settings())
    return s


class TestVitesseVoix(unittest.TestCase):
    def setUp(self):
        self.s = session()

    def tearDown(self):
        self.s.close()

    def item(self, texte, src_dur, t1=0.0):
        return _TtsItem(1, 1, 0, texte, 0.0, t1, True, src_dur)

    def test_phrase_courte_vitesse_normale(self):
        rate, _lag, boost = self.s._speech_rate(self.item("Bonjour.", 2.0))
        self.assertEqual(boost, 1.0)
        self.assertEqual(rate, 1.0)

    def test_phrase_trop_longue_acceleree_pour_tenir_la_duree(self):
        texte = "x" * 70  # ≈ 5 s à 14 caractères/s pour 3 s d'anglais
        _rate, _lag, boost = self.s._speech_rate(self.item(texte, 3.0))
        self.assertGreater(boost, 1.2)

    def test_acceleration_plafonnee(self):
        _rate, _lag, boost = self.s._speech_rate(self.item("x" * 500, 1.0))
        self.assertAlmostEqual(boost, self.s.cfg.max_speedup)

    def test_retard_existant_resorbe(self):
        self.s.playback_report(6.0)  # 6 s de voix encore à jouer
        _rate, lag, boost = self.s._speech_rate(self.item("Bonjour.", 2.0))
        self.assertAlmostEqual(lag, 6.0, delta=0.05)
        self.assertGreater(boost, 1.2)

    def test_acceleration_desactivable(self):
        self.s.settings.auto_speedup = False
        self.s.playback_report(10.0)
        _rate, _lag, boost = self.s._speech_rate(self.item("x" * 200, 1.0))
        self.assertEqual(boost, 1.0)

    def test_apprentissage_du_debit_de_la_voix(self):
        self.s._learn_voice_speed("siwis", "x" * 100, 5.0, 1.0)  # 20 car./s
        self.s._learn_voice_speed("siwis", "x" * 100, 5.0, 1.0)
        self.assertAlmostEqual(self.s._cps_ema["siwis"], 20.0, places=3)


class TestFileVoix(unittest.TestCase):
    def test_estimation_et_recalage(self):
        s = session()
        try:
            self.assertEqual(s.voice_queue_s(), 0.0)
            s.playback_report(3.0)
            self.assertAlmostEqual(s.voice_queue_s(), 3.0, delta=0.05)
            time.sleep(0.2)
            self.assertAlmostEqual(s.voice_queue_s(), 2.8, delta=0.08)
            s.reset(2)  # saut dans la vidéo : la file est vidée
            self.assertEqual(s.voice_queue_s(), 0.0)
        finally:
            s.close()

    def test_session_inactive_au_repos(self):
        s = session()
        try:
            self.assertTrue(s.idle())
        finally:
            s.close()


class TestDecoupageAdaptatif(unittest.TestCase):
    def test_pc_rapide_garde_la_cible(self):
        s = session()
        try:
            for _ in range(5):
                s._adapt_segments(0.4)
            self.assertAlmostEqual(s.segmenter.soft_max_s, s.cfg.soft_max_segment_s)
        finally:
            s.close()

    def test_pc_lent_allonge_les_propositions(self):
        s = session()
        try:
            for _ in range(10):
                s._adapt_segments(2.0)  # 2 s par appel de reconnaissance
            self.assertGreater(s.segmenter.soft_max_s, 6.0)
            self.assertLessEqual(s.segmenter.soft_max_s, 8.0)
            self.assertGreater(s.segmenter.hard_max_s, s.segmenter.soft_max_s)
        finally:
            s.close()

    def test_adaptation_desactivable(self):
        s = session(adaptive_segments=False)
        try:
            for _ in range(10):
                s._adapt_segments(3.0)
            self.assertAlmostEqual(s.segmenter.soft_max_s, s.cfg.soft_max_segment_s)
        finally:
            s.close()


class TestModeleRapide(unittest.TestCase):
    def test_pc_trop_lent_bascule_vers_un_modele_plus_rapide(self):
        s = session()
        try:
            for _ in range(5):
                s._watch_asr_speed(3.0, 3.5)  # 0,86 × temps réel
            self.assertEqual(s.engines.bascules, 1)
        finally:
            s.close()

    def test_pc_rapide_garde_son_modele(self):
        s = session()
        try:
            for _ in range(10):
                s._watch_asr_speed(0.6, 3.0)
            self.assertEqual(s.engines.bascules, 0)
        finally:
            s.close()


class TestBlancs(unittest.TestCase):
    def test_blancs_retires(self):
        sr = 22050
        voix = (np.sin(np.arange(sr) / 5) * 8000).astype("<i2")
        blanc = np.zeros(sr // 2, dtype="<i2")
        pcm = np.concatenate([blanc, voix, blanc]).tobytes()
        out = np.frombuffer(trim_silence(pcm, sr), dtype="<i2")
        self.assertLess(out.size, voix.size + int(0.1 * sr))
        self.assertGreaterEqual(out.size, voix.size - 10)

    def test_silence_total_inchange(self):
        pcm = bytes(4000)
        self.assertEqual(trim_silence(pcm, 22050), pcm)


if __name__ == "__main__":
    unittest.main()
