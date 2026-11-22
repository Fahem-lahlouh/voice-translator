"""Tests de la configuration et de la validation des messages du serveur."""

import json
import tempfile
import unittest
from pathlib import Path

from vt_server.config import Config, load_config
from vt_server.pipeline import parse_settings
from vt_server.server import ProtocolError, LocalServer


class TestConfig(unittest.TestCase):
    def test_profil_applique_ses_modeles(self):
        c = Config(profile="equilibre").resolved()
        self.assertEqual(c.asr_model, "small.en")
        self.assertGreater(c.cpu_threads, 0)

    def test_profil_inconnu_refuse(self):
        with self.assertRaises(ValueError):
            Config(profile="turbo").resolved()

    def test_ecoute_hors_boucle_locale_refusee(self):
        for host in ("0.0.0.0", "192.168.1.10", "::"):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    Config(host=host).resolved()

    def test_option_inconnue_dans_le_fichier(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.json"
            p.write_text(json.dumps({"profil": "prudent"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(p)

    def test_jeton_absent_des_informations_publiques(self):
        c = Config(auth_token="secret").resolved()
        self.assertNotIn("auth_token", c.public_dict())

    def test_origine_autorisee(self):
        c = Config(allowed_extension_ids=["abc"]).resolved()
        self.assertEqual(c.allowed_origins(), {"chrome-extension://abc"})


class TestReglages(unittest.TestCase):
    def test_valeurs_par_defaut(self):
        s = parse_settings({})
        self.assertEqual((s.source, s.target), ("en", "fr"))

    def test_paire_non_installee_refusee(self):
        with self.assertRaises(ValueError):
            parse_settings({"source": "de", "target": "fr"})

    def test_voix_inconnue_refusee(self):
        with self.assertRaises(ValueError):
            parse_settings({"voice": "inconnue"})

    def test_vitesse_hors_bornes_refusee(self):
        for mauvais in (0.1, 9.0, "1.0", True):
            with self.subTest(mauvais=mauvais):
                with self.assertRaises(ValueError):
                    parse_settings({"rate": mauvais})

    def test_reglage_inconnu_refuse(self):
        with self.assertRaises(ValueError):
            parse_settings({"volumeSecret": 1})

    def test_glossaire_valide(self):
        s = parse_settings({"glossary": [{"src": "TIBCO", "aliases": ["tipco"]}]})
        self.assertEqual(len(s.glossary.entries), 1)

    def test_glossaire_invalide_refuse(self):
        with self.assertRaises(ValueError):
            parse_settings({"glossary": [{"src": ""}]})

    def test_mise_a_jour_partielle_conserve_le_reste(self):
        base = parse_settings({"voice": "upmc-pierre", "rate": 1.2})
        suite = parse_settings({"rate": 1.4}, base)
        self.assertEqual(suite.voice, "upmc-pierre")
        self.assertEqual(suite.rate, 1.4)


class TestMessages(unittest.TestCase):
    def test_json_invalide_refuse(self):
        for mauvais in ("pas du json", "[]", '"texte"', '{"sans_type": 1}'):
            with self.subTest(mauvais=mauvais):
                with self.assertRaises(ProtocolError):
                    LocalServer._parse_json(mauvais)

    def test_message_trop_long_refuse(self):
        with self.assertRaises(ProtocolError):
            LocalServer._parse_json('{"type":"x","p":"' + "a" * 5_000_000 + '"}')

    def test_message_binaire_refuse_comme_texte(self):
        with self.assertRaises(ProtocolError):
            LocalServer._parse_json(b"\x00\x01")

    def test_trame_audio_mal_formee(self):
        class FauxSession:
            def feed(self, epoch, pcm):
                self.vu = (epoch, len(pcm))

        for mauvais in (b"\x01\x02", b"\x00\x00\x00\x00\x01", bytes(4 + 16000 * 2 * 3)):
            with self.subTest(taille=len(mauvais)):
                with self.assertRaises(ProtocolError):
                    LocalServer._on_audio(FauxSession(), mauvais)

    def test_transcription_pour_resume_validee(self):
        ok = LocalServer._valid_segments([{"start": 5, "end": 7, "en": " Hello. "}, {"start": 1, "end": 2, "en": "Hi"}])
        self.assertEqual([s["en"] for s in ok], ["Hi", "Hello."])  # triées, nettoyées
        for mauvais in ([], "texte", [{"start": "a", "end": 1, "en": "x"}], [{"start": 1, "end": 2, "en": 3}],
                        [{"start": 1, "end": 2, "en": "   "}]):
            with self.subTest(mauvais=mauvais):
                with self.assertRaises(ProtocolError):
                    LocalServer._valid_segments(mauvais)

    def test_outil_repond_avec_identifiant_de_requete(self):
        import asyncio
        import json

        class FauxResume:
            def status(self):
                return [{"id": "llama3.2-3b"}]

        class FauxWs:
            def __init__(self, msgs):
                self.msgs = msgs

            def __aiter__(self):
                return self._gen()

            async def _gen(self):
                for m in self.msgs:
                    yield m

        srv = LocalServer.__new__(LocalServer)
        srv.summarizer = FauxResume()
        recus = []
        asyncio.run(srv._tool_loop(FauxWs([json.dumps({"type": "llm_status", "requestId": "r1"})]), recus.append))
        self.assertEqual(recus[0]["type"], "hello_ok")
        self.assertEqual((recus[1]["type"], recus[1]["requestId"]), ("llm_status", "r1"))
        with self.assertRaises(ProtocolError):
            asyncio.run(srv._tool_loop(FauxWs([json.dumps({"type": "llm_status", "requestId": 5})]), recus.append))

    def test_trame_audio_valide(self):
        class FauxSession:
            vu = None

            def feed(self, epoch, pcm):
                self.vu = (epoch, len(pcm))

        s = FauxSession()
        LocalServer._on_audio(s, (7).to_bytes(4, "little") + bytes(3200))
        self.assertEqual(s.vu, (7, 3200))


if __name__ == "__main__":
    unittest.main()
