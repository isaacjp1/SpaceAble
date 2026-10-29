"""WCAG 2.x contrast for the app's palette, read from Sources/SpaceAble/Theme.swift. Run: python3 check_contrast.py"""
import re
from pathlib import Path

theme = (Path(__file__).parent / "Sources/SpaceAble/Theme.swift").read_text()
tokens = {name: {"light": light, "dark": dark} for name, light, dark in
          re.findall(r"static let (\w+) = Color\(light: 0x(\w{6}), dark: 0x(\w{6})\)", theme)}

def luminance(hex_):
    c = [int(hex_[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)

SURFACES = ("canvas", "card", "raised")
PAIRS = [  # foreground, background, minimum, where
    *[("ink", bg, 7, "primary text") for bg in SURFACES],
    *[("muted", bg, 4.5, "secondary text, chips") for bg in SURFACES],
    *[("terracotta", bg, 4.5, "accent text and symbols") for bg in SURFACES],
    *[("sage", bg, 4.5, "success symbol, legend") for bg in SURFACES],
    *[("danger", bg, 4.5, "destructive button") for bg in SURFACES],
    ("onAccent", "terracotta", 4.5, "filled pill label"),
    *[("stone", bg, 3, "field border, outlined pill, plan walls") for bg in SURFACES],
    *[(fg, "raised", 3, "plan graphics on the floor") for fg in ("ink", "terracotta", "sage")],
]

failures = 0
for mode in ("light", "dark"):
    for fg, bg, need, where in PAIRS:
        r = contrast(tokens[fg][mode], tokens[bg][mode])
        failures += r < need
        print(f"{mode:5} {fg:10} on {bg:10} {r:5.2f}  needs {need:<3} {'ok' if r >= need else 'FAIL'}  {where}")
assert len(tokens) >= 11, f"read only {len(tokens)} tokens from Theme.swift"
assert not failures, f"{failures} pair(s) below WCAG"
