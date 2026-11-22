import os
import unittest

from vt_server import diagnostic


class TestDiagnostic(unittest.TestCase):
    def test_rapport_sans_chemin_personnel(self):
        texte = f"{diagnostic.ROOT}/test/audio/x.ogg et {os.path.expanduser('~')}/Documents"
        propre = diagnostic._anonymize(texte)
        self.assertNotIn(str(diagnostic.ROOT), propre)
        self.assertIn("<projet>/test/audio/x.ogg", propre)
        if os.path.expanduser("~") not in ("~", "/"):
            self.assertNotIn(os.path.expanduser("~"), propre)

    def test_caracteristiques_du_pc(self):
        info = diagnostic.machine()
        self.assertGreaterEqual(info["coeurs_logiques"], 1)
        self.assertGreater(info["disque_libre_go"], 0)


if __name__ == "__main__":
    unittest.main()
