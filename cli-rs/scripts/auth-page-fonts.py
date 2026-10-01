#!/usr/bin/env -S uv run --quiet --python 3.13 --with fonttools>=4.55 --with brotli python
"""Print the @font-face block inlined in wispctl's OAuth success page.

The page is served from the loopback callback listener, which closes after one
response, so it cannot load fonts from anywhere and must work offline. This
instances and subsets the Google Fonts sources (OFL; licence kept in each
font's name table) to the glyphs the page uses and inlines them as WOFF2.

usage: cli-rs/scripts/auth-page-fonts.py > /tmp/fonts.css
"""
import base64
import io
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

OFL = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
ASCII = range(0x20, 0x7F)
LETTERS = [*range(0x41, 0x5B), *range(0x61, 0x7B), 0x20]

FONTS = [
    # family, source, axes, weight, unicodes
    ("Fraunces", "fraunces/Fraunces%5BSOFT,WONK,opsz,wght%5D.ttf", {"wght": 700, "SOFT": 100, "WONK": 1, "opsz": 24}, "700", ASCII),
    ("Caveat", "caveat/Caveat%5Bwght%5D.ttf", {"wght": 700}, "700", LETTERS),
    ("JetBrains Mono", "jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf", {"wght": (400, 600)}, "400 600", [*ASCII, 0xB7, 0x2318]),
]


def build(source, axes, unicodes):
    font = TTFont(io.BytesIO(urllib.request.urlopen(OFL + source).read()))
    options = subset.Options()
    options.flavor = "woff2"
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]  # keep copyright and licence
    options.layout_features = ["kern", "liga"]
    options.hinting = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=list(unicodes))
    subsetter.subset(font)
    # Instance after subsetting: fontTools trips over gvar the other way round.
    font = instancer.instantiateVariableFont(font, axes)
    font.flavor = "woff2"
    out = io.BytesIO()
    font.save(out)
    return base64.b64encode(out.getvalue()).decode()


for family, source, axes, weight, unicodes in FONTS:
    print(
        f'@font-face {{ font-family: "{family}"; font-weight: {weight}; font-display: block; '
        f'src: url(data:font/woff2;base64,{build(source, axes, unicodes)}) format("woff2"); }}'
    )
