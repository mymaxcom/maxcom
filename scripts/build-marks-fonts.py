# Builds the "marks-only" fonts of the harakat colour (themes plan D, spec 6.12.2) from the OFL Amiri fonts.
#
#   python scripts/build-marks-fonts.py
#
# Every glyph that is not a combining mark is emptied; advance widths, GSUB and GPOS stay, so the same text drawn
# on top of the full text, in the harakat colour, lands exactly on the marks of the text below. Only the OFL
# fonts are derived this way; the KFGQPC Hafs file is never touched (its licence asks for it to be used unmodified).
# The derived fonts carry new family names (the OFL asks that of a modified version). The outputs are committed
# (apps/kiosk-display/src/assets/fonts/marks/), so this script runs only when the sources change.
# Needs: pip install fonttools   (the WOFF flavour needs no further package)
import os
import sys

from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SRC = os.path.join(REPO, 'node_modules', '@fontsource')
OUT = os.path.join(REPO, 'apps', 'kiosk-display', 'src', 'assets', 'fonts', 'marks')

JOBS = [
    (os.path.join(SRC, 'amiri-quran', 'files', 'amiri-quran-arabic-400-normal.woff'), 'mx-harakat-quran.woff', 'MX Harakat Quran'),
    (os.path.join(SRC, 'amiri', 'files', 'amiri-arabic-400-normal.woff'), 'mx-harakat-naskh-400.woff', 'MX Harakat Naskh'),
    (os.path.join(SRC, 'amiri', 'files', 'amiri-arabic-700-normal.woff'), 'mx-harakat-naskh-700.woff', 'MX Harakat Naskh'),
]


def build(src: str, out: str, family: str) -> int:
    font = TTFont(src)
    gdef = font['GDEF'].table if 'GDEF' in font else None
    classes = gdef.GlyphClassDef.classDefs if gdef is not None and gdef.GlyphClassDef is not None else {}
    marks = {g for g, c in classes.items() if c == 3}
    if not marks:
        print(f'{os.path.basename(src)}: no GDEF mark class, refusing to build', file=sys.stderr)
        return 1
    glyf = font['glyf']
    emptied = 0
    for name in font.getGlyphOrder():
        if name not in marks and name != '.notdef':
            glyf[name] = TTGlyphPen(None).glyph()
            emptied += 1
    for rec in font['name'].names:
        if rec.nameID in (1, 4, 16):
            rec.string = family
        if rec.nameID == 6:
            rec.string = family.replace(' ', '') + '-Regular'
    font.flavor = 'woff'
    font.save(os.path.join(OUT, out))
    print(f'{out} marks {len(marks)} emptied {emptied}')
    return 0


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for src, out, family in JOBS:
        if not os.path.exists(src):
            print(f'missing source {src} (run npm install)', file=sys.stderr)
            return 1
        code = build(src, out, family)
        if code != 0:
            return code
    return 0


if __name__ == '__main__':
    sys.exit(main())
