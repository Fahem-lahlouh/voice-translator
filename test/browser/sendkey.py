"""Envoie un raccourci clavier réel à la fenêtre Chrome (via XTEST).

Nécessaire parce qu'un raccourci traité par le navigateur lui-même (ici
« Ctrl+Maj+Y », qui invoque l'extension et accorde l'autorisation activeTab)
ne peut pas être simulé depuis la page.

Usage : python sendkey.py [ctrl+shift+y]
"""
import sys
import time

from Xlib import X, display
from Xlib.ext import xtest

MODS = {"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L"}


def main() -> int:
    combo = (sys.argv[1] if len(sys.argv) > 1 else "ctrl+shift+y").lower().split("+")
    *mods, key = combo
    d = display.Display()
    # Donner le focus à la fenêtre la plus grande (celle de Chrome).
    root = d.screen().root
    best, best_area = None, 0
    for w in root.query_tree().children:
        try:
            g = w.get_geometry()
            attrs = w.get_attributes()
        except Exception:
            continue
        if attrs.map_state != X.IsViewable:
            continue
        if g.width * g.height > best_area:
            best, best_area = w, g.width * g.height
    if best is not None:
        try:
            best.set_input_focus(X.RevertToParent, X.CurrentTime)
            best.configure(stack_mode=X.Above)
            d.sync()
        except Exception:
            pass
        time.sleep(0.2)

    def code(name):
        return d.keysym_to_keycode(display.Xlib.XK.string_to_keysym(name))

    from Xlib import XK

    def kc(name):
        return d.keysym_to_keycode(XK.string_to_keysym(name))

    seq = [kc(MODS[m]) for m in mods] + [kc(key.upper() if len(key) == 1 else key)]
    for c in seq:
        xtest.fake_input(d, X.KeyPress, c)
        d.sync()
        time.sleep(0.03)
    for c in reversed(seq):
        xtest.fake_input(d, X.KeyRelease, c)
        d.sync()
        time.sleep(0.03)
    d.flush()
    print("raccourci envoyé :", "+".join(combo), "sur la fenêtre", best_area, "px²")
    return 0


if __name__ == "__main__":
    sys.exit(main())
