"""Serveur web local pour la page de test, avec prise en charge des requêtes
partielles (« Range »).

Le serveur intégré de Python (`python -m http.server`) ne les gère pas : Chrome
ne peut alors pas se positionner au milieu d'un fichier audio, et tout saut
dans la vidéo la fait repartir du début. Les vrais sites (YouTube, Udemy…)
les gèrent.

Usage : python test/serveur_test.py [port]   puis http://127.0.0.1:8777/page/
"""
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RANGE_RX = re.compile(r"bytes=(\d*)-(\d*)$")


class RangeHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        m = RANGE_RX.match(self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2) or 0))
        end = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416, "Plage demandée invalide")
            return None
        f = open(path, "rb")
        f.seek(start)
        self._remaining = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self._remaining))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
        self._remaining = None

    def log_message(self, *args):
        pass  # silencieux


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    root = os.path.dirname(os.path.abspath(__file__))
    srv = ThreadingHTTPServer(("127.0.0.1", port), partial(RangeHandler, directory=root))
    print(f"Page de test : http://127.0.0.1:{port}/page/  (Ctrl+C pour arrêter)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
