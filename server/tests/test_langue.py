"""Tests de l'étape « langue » : prononciation, expressions, type de contenu."""

import unittest

from vt_server.idioms import Idioms
from vt_server.pipeline import parse_settings
from vt_server.pronunciation import Pronouncer, parse_rules, spell
from vt_server.textproc import Glossary, parse_glossary


class TestPrononciation(unittest.TestCase):
    def setUp(self):
        self.p = Pronouncer()

    def test_sigle_court_epele(self):
        self.assertEqual(self.p.apply("Nous utilisons SAP."), "Nous utilisons èss a pé.")

    def test_elision_ne_fusionne_plus_le_sigle(self):
        self.assertEqual(self.p.apply("C'est l'ERP."), "C'est l'euh èr pé.")
        self.assertIn("l'a pé i", self.p.apply("Appelez l'API."))

    def test_sigle_prononcable_lu_comme_un_mot(self):
        self.assertIn("nasa", self.p.apply("La NASA."))
        self.assertIn("otan", self.p.apply("L'OTAN."))

    def test_cia_corrigee(self):
        self.assertIn("cé i a", self.p.apply("La CIA."))

    def test_pluriel_et_chiffres(self):
        self.assertIn("pé dé èf", self.p.apply("Des PDFs."))
        self.assertIn("èm pé 3", self.p.apply("Un MP3."))

    def test_mots_francais_en_majuscules_non_epeles(self):
        self.assertEqual(self.p.apply("NON, ce n'est pas vrai !"), "NON, ce n'est pas vrai !")

    def test_chiffres_romains_non_epeles(self):
        self.assertEqual(self.p.apply("Louis XIV et le chapitre III."), "Louis XIV et le chapitre III.")

    def test_sigle_dans_un_mot_intact(self):
        self.assertEqual(self.p.apply("Le SAP-Connector et MySAP."), "Le SAP-Connector et MySAP.")

    def test_minuscules_non_touchees(self):
        self.assertEqual(self.p.apply("la sève, sap en anglais"), "la sève, sap en anglais")

    def test_noms_de_marques(self):
        self.assertIn("you tioube", self.p.apply("Sur YouTube."))

    def test_regle_utilisateur_prioritaire(self):
        p = Pronouncer(parse_rules([{"term": "SAP", "mode": "mot"}]))
        self.assertIn("sap", p.apply("Avec SAP."))
        self.assertNotIn("èss", p.apply("Avec SAP."))

    def test_regle_limitee_a_un_type_de_contenu(self):
        rules = parse_rules([{"term": "Spring", "mode": "dire", "say": "sprinne", "domain": "formation"}])
        self.assertIn("sprinne", Pronouncer(rules, "formation").apply("Le Spring."))
        self.assertNotIn("sprinne", Pronouncer(rules, "film").apply("Le Spring."))

    def test_regles_invalides_refusees(self):
        for mauvais in ([{"term": "", "mode": "mot"}], [{"term": "X", "mode": "chanter"}],
                        [{"term": "X", "mode": "dire", "say": ""}], "texte"):
            with self.assertRaises(ValueError):
                parse_rules(mauvais)

    def test_epeler(self):
        self.assertEqual(spell("Wi"), "double vé i")


class TestExpressions(unittest.TestCase):
    def setUp(self):
        self.i = Idioms()

    def test_phrase_entiere(self):
        self.assertEqual(self.i.whole("It's raining cats and dogs."), "Il pleut des cordes.")
        self.assertEqual(self.i.whole("let’s call it a day!"), "On s'arrête là pour aujourd'hui.")

    def test_phrase_normale_non_touchee(self):
        self.assertIsNone(self.i.whole("We need to deploy the application."))
        self.assertEqual(self.i.spans("We need to deploy the application."), [])

    def test_fragment_dans_une_phrase(self):
        sp = self.i.spans("That exam was a piece of cake.")
        self.assertEqual([fr for _a, _b, fr in sp], ["du gâteau"])

    def test_phrase_enrobee(self):
        sp = self.i.spans("Well, let's call it a day, guys.")
        self.assertEqual([fr for _a, _b, fr in sp], ["on s'arrête là pour aujourd'hui"])

    def test_expression_reservee_aux_phrases_entieres(self):
        # « no way » n'est remplacé que s'il constitue la réplique.
        self.assertEqual(self.i.spans("There is no way to know."), [])

    def test_expression_utilisateur(self):
        i = Idioms([("hit the road", "prendre la route")])
        self.assertEqual([fr for *_x, fr in i.spans("We should hit the road soon.")], ["prendre la route"])

    def test_glossaire_porte_les_expressions(self):
        g = Glossary(parse_glossary([{"kind": "idiom", "src": "hit the road", "dst": "prendre la route"}]))
        self.assertEqual(g.idioms, [("hit the road", "prendre la route")])
        with self.assertRaises(ValueError):
            parse_glossary([{"kind": "idiom", "src": "x", "dst": ""}])


class TestTypeDeContenu(unittest.TestCase):
    def test_type_et_prononciation_transmis(self):
        s = parse_settings({"contentMode": "formation",
                            "pronunciation": [{"term": "IT", "mode": "epeler", "domain": "formation"}]})
        self.assertEqual(s.content_mode, "formation")
        self.assertIn("i té", s.pronouncer.apply("Le service IT."))

    def test_type_inconnu_refuse(self):
        with self.assertRaises(ValueError):
            parse_settings({"contentMode": "jeu"})

    def test_mise_a_jour_du_type_conserve_les_regles(self):
        base = parse_settings({"pronunciation": [{"term": "SAP", "mode": "mot"}]})
        suite = parse_settings({"contentMode": "film"}, base)
        self.assertIn("sap", suite.pronouncer.apply("SAP"))


if __name__ == "__main__":
    unittest.main()
