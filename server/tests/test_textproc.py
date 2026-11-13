"""Tests du traitement du texte : phrases, glossaire, termes techniques."""

import unittest

from vt_server.textproc import (
    Glossary,
    find_code_spans,
    looks_degenerate,
    parse_glossary,
    protect,
    protected_terms,
    restore,
    speakable_fr,
    split_sentences,
)


class TestPhrases(unittest.TestCase):
    def test_decoupe_simple(self):
        self.assertEqual(
            split_sentences("Hello there. How are you? Fine!"),
            ["Hello there.", "How are you?", "Fine!"],
        )

    def test_ne_coupe_pas_sur_abreviation(self):
        self.assertEqual(
            split_sentences("Use the JDBC driver, e.g. Oracle. Then deploy."),
            ["Use the JDBC driver, e.g. Oracle.", "Then deploy."],
        )

    def test_ne_coupe_pas_un_nombre_decimal(self):
        self.assertEqual(split_sentences("Install TIBCO BW 6.5 now."), ["Install TIBCO BW 6.5 now."])

    def test_ne_coupe_pas_un_identifiant(self):
        self.assertEqual(
            split_sentences("Open com.example.Main and run it."),
            ["Open com.example.Main and run it."],
        )

    def test_ne_coupe_pas_une_initiale(self):
        self.assertEqual(split_sentences("Ask J. Smith about it."), ["Ask J. Smith about it."])

    def test_phrase_inachevee(self):
        self.assertEqual(split_sentences("First we open the"), ["First we open the"])

    def test_vide(self):
        self.assertEqual(split_sentences("   "), [])


class TestGlossaire(unittest.TestCase):
    def test_validation_refuse_entree_invalide(self):
        for mauvais in ([{"src": ""}], [{"src": "a" * 200}], ["texte"], [{"src": "x", "aliases": "y"}],
                        [{"kind": "post", "src": "x", "dst": ""}], [{"src": "x", "kind": "autre"}]):
            with self.subTest(mauvais=mauvais):
                with self.assertRaises(ValueError):
                    parse_glossary(mauvais)

    def test_validation_limite_le_nombre(self):
        with self.assertRaises(ValueError):
            parse_glossary([{"src": f"t{i}"} for i in range(400)])

    def test_correction_des_formes_mal_reconnues(self):
        g = Glossary(parse_glossary([{"src": "TIBCO", "aliases": ["tipco", "tickle"]}]))
        self.assertEqual(g.correct_transcript("Open tipco Studio"), "Open TIBCO Studio")
        self.assertEqual(g.correct_transcript("the tickle engine"), "the TIBCO engine")

    def test_restaure_la_casse_officielle(self):
        g = Glossary(parse_glossary([{"src": "BusinessWorks", "aliases": ["business works"]}]))
        self.assertEqual(g.correct_transcript("open businessworks now"), "open BusinessWorks now")

    def test_ne_corrige_pas_au_milieu_d_un_mot(self):
        g = Glossary(parse_glossary([{"src": "EMS"}]))
        self.assertEqual(g.correct_transcript("systems are fine"), "systems are fine")

    def test_amorce_de_reconnaissance(self):
        g = Glossary(parse_glossary([{"src": "TIBCO"}, {"src": "BusinessWorks"}, {"src": "lecture"}]))
        prompt = g.asr_prompt()
        self.assertIn("TIBCO", prompt)
        self.assertIn("BusinessWorks", prompt)
        self.assertNotIn("lecture", prompt)  # pas un nom propre
        self.assertTrue(prompt.endswith("."))

    def test_substitution_des_traductions_imposees(self):
        g = Glossary(parse_glossary([{"src": "shared resource", "dst": "ressource partagée"}]))
        src, attendus = g.substitute_forced("It uses a shared resource here.")
        self.assertEqual(src, "It uses a ressource partagée here.")
        self.assertEqual(attendus, ["ressource partagée"])

    def test_remplacement_apres_traduction(self):
        g = Glossary(parse_glossary([{"kind": "post", "src": "conférence", "dst": "leçon"}]))
        self.assertEqual(g.apply_post("Dans cette conférence"), "Dans cette leçon")
        self.assertEqual(g.apply_post("Conférence suivante"), "Leçon suivante")

    def test_terme_le_plus_long_d_abord(self):
        g = Glossary(parse_glossary([{"src": "TIBCO"}, {"src": "TIBCO Business Studio"}]))
        spans = g.find("Open TIBCO Business Studio now")
        self.assertEqual([s[2].src for s in spans], ["TIBCO Business Studio"])


class TestTermesProteges(unittest.TestCase):
    def extraits(self, texte):
        return [texte[a:b] for a, b in find_code_spans(texte)]

    def test_detecte_les_formes_de_code(self):
        cas = {
            "call getCustomerById() now": ["getCustomerById()"],
            "see C:\\tibco\\bw\\6.5\\logs here": ["C:\\tibco\\bw\\6.5\\logs"],
            "edit /etc/nginx/nginx.conf now": ["/etc/nginx/nginx.conf"],
            "the max_sessions value": ["max_sessions"],
            "class com.acme.Main runs": ["com.acme.Main"],
            "go to https://example.com/a/b now": ["https://example.com/a/b"],
            "pass --verbose to it": ["--verbose"],
        }
        for texte, attendu in cas.items():
            with self.subTest(texte=texte):
                self.assertEqual(self.extraits(texte), attendu)

    def test_ignore_les_abreviations_courantes(self):
        self.assertEqual(self.extraits("use it, e.g. now"), [])

    def test_n_avale_pas_la_ponctuation_finale(self):
        self.assertEqual(self.extraits("open com.acme.Main."), ["com.acme.Main"])

    def test_jetons_poses_et_restaures(self):
        g = Glossary(parse_glossary([{"src": "TIBCO"}]))
        texte = "Deploy TIBCO to the AppNode using deploy.sh"
        prot = protect(texte, g, code=True)
        self.assertNotIn("TIBCO", prot.text)
        self.assertIn("ZX1Q", prot.text)
        rendu, ok = restore(prot.text, prot)
        self.assertTrue(ok)
        self.assertEqual(rendu, texte)

    def test_jeton_perdu_signale(self):
        g = Glossary(parse_glossary([{"src": "TIBCO"}]))
        prot = protect("Deploy TIBCO now", g, code=True)
        _rendu, ok = restore("Déployez maintenant", prot)
        self.assertFalse(ok)

    def test_jeton_residuel_nettoye(self):
        g = Glossary([])
        prot = protect("rien", g, code=False)
        rendu, ok = restore("texte ZX7Q restant", prot)
        self.assertFalse(ok)
        self.assertNotIn("ZX7Q", rendu)

    def test_termes_a_conserver(self):
        g = Glossary(parse_glossary([{"src": "TIBCO"}, {"src": "lecture", "dst": "leçon"}]))
        termes = protected_terms("In this lecture, deploy TIBCO with run.sh", g)
        self.assertIn("TIBCO", termes)
        self.assertIn("run.sh", termes)
        self.assertNotIn("lecture", termes)  # traduit, donc pas à conserver


class TestQualite(unittest.TestCase):
    def test_repetitions_detectees(self):
        self.assertTrue(looks_degenerate("Hello there.", "le le le le le le le"))

    def test_longueur_aberrante(self):
        self.assertTrue(looks_degenerate("This is a normal sentence.", "a"))
        self.assertTrue(looks_degenerate("This is a normal sentence.", "x" * 200))

    def test_traduction_normale_acceptee(self):
        self.assertFalse(looks_degenerate(
            "It uses a shared resource.", "Il utilise une ressource partagée."))

    def test_vide_rejete(self):
        self.assertTrue(looks_degenerate("Hello", "  "))


class TestTexteAPrononcer(unittest.TestCase):
    def test_identifiant_decoupe(self):
        self.assertIn("get Customer By Id", speakable_fr("Appelez getCustomerById maintenant"))

    def test_chemin_windows(self):
        dit = speakable_fr("Voyez C:\\tibco\\bw\\logs")
        self.assertNotIn("\\", dit)
        self.assertIn("tibco", dit)

    def test_url_lue_par_domaine(self):
        self.assertIn("point", speakable_fr("Allez sur https://exemple.com/a/b"))

    def test_symboles_remplaces(self):
        self.assertIn("égal", speakable_fr("mettez x = 10"))
        self.assertIn("vers", speakable_fr("mappez a -> b"))

    def test_chemin_long_raccourci(self):
        dit = speakable_fr("dans /a/b/c/d/e/f/g/h.log")
        self.assertLess(len(dit.split()), 12)

    def test_texte_normal_inchange(self):
        texte = "Nous allons créer un nouveau processus."
        self.assertEqual(speakable_fr(texte), texte)


if __name__ == "__main__":
    unittest.main()
