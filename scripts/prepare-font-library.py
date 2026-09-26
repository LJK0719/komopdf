# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.59.2", "freetype-py==2.5.1"]
# ///
"""Prepare the extended font library from pinned upstream sources.

Run with uv run scripts/prepare-font-library.py after prepare-fonts.py.
Variable fonts are instantiated into static faces for the PDF runtime.
Missing italic faces get real oblique outlines, not a CSS-only preview.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib
import ctypes
import freetype
import importlib.util
import json
import math
import re
import zipfile
from urllib.parse import quote
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.t2CharStringPen import T2CharStringPen

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'resources/downloads/fonts'
spec = importlib.util.spec_from_file_location('prepare_fonts', Path(__file__).with_name('prepare-fonts.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def names(font, family, style):
    stem = re.sub(r'[^A-Za-z0-9-]', '', family) or (font['name'].getDebugName(6) or 'KomoFont').split('-')[0]
    postscript = stem + '-' + style.replace(' ', '')
    for name_id, value in [(1, family), (2, style), (4, family + ' ' + style), (6, postscript), (16, family), (17, style)]:
        font['name'].setName(value, name_id, 3, 1, 0x409)
        font['name'].setName(value if value.isascii() else postscript, name_id, 1, 0, 0)
    return postscript


def embolden(font, source):
    face = freetype.Face(str(source))
    strength = max(1, round(font['head'].unitsPerEm * 0.025))
    for index, name in enumerate(font.getGlyphOrder()):
        face.load_glyph(index, freetype.FT_LOAD_NO_SCALE | freetype.FT_LOAD_NO_HINTING | freetype.FT_LOAD_NO_BITMAP)
        outline = face.glyph.outline
        if not outline.n_points:
            continue
        error = freetype.FT_Outline_Embolden(ctypes.byref(outline._FT_Outline), strength)
        if error:
            raise RuntimeError(f'Unable to embolden glyph {name}: {error}')
        pen = TTGlyphPen(None)
        opened = False
        def move(point, context):
            nonlocal opened
            if opened:
                pen.closePath()
            pen.moveTo((point.x, point.y))
            opened = True
        outline.decompose(move_to=move,
                          line_to=lambda point, context: pen.lineTo((point.x, point.y)),
                          conic_to=lambda control, point, context: pen.qCurveTo((control.x, control.y), (point.x, point.y)))
        if opened:
            pen.closePath()
        font['glyf'][name] = pen.glyph()
        advance, bearing = font['hmtx'][name]
        font['hmtx'][name] = (advance + strength if advance else 0, bearing)
    font['OS/2'].usWeightClass = 700
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection | (1 << 5)) & ~(1 << 6)
    font['head'].macStyle |= 1


def oblique(font):
    matrix = (1, 0, math.tan(math.radians(12)), 1, 0, 0)
    glyphs = font.getGlyphSet()
    if 'glyf' in font:
        replacements = {}
        for name in font.getGlyphOrder():
            pen = TTGlyphPen(glyphs)
            glyphs[name].draw(TransformPen(pen, matrix))
            replacements[name] = pen.glyph()
        for name, glyph in replacements.items():
            font['glyf'][name] = glyph
    elif 'CFF ' in font:
        top = font['CFF '].cff.topDictIndex[0]
        replacements = {}
        for name in font.getGlyphOrder():
            old = top.CharStrings[name]
            pen = T2CharStringPen(font['hmtx'][name][0], glyphs)
            glyphs[name].draw(TransformPen(pen, matrix))
            replacements[name] = pen.getCharString(private=old.private, globalSubrs=old.globalSubrs)
        for name, charstring in replacements.items():
            top.CharStrings[name] = charstring
        top.ItalicAngle = -12
    else:
        raise ValueError('Unsupported outline for oblique generation')
    font['post'].italicAngle = -12
    font['head'].macStyle |= 2
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection | 1) & ~(1 << 6)


def record(path, identifier, family, style, weight, italic, notice, owner):
    data = path.read_bytes()
    info = base.sfnt(data)
    return {'id': identifier, 'family': family, 'style': style, 'weight': weight, 'italic': italic,
            **info, 'sha256': digest(data), 'bytes': len(data), 'path': path.relative_to(ROOT).as_posix(),
            'licensePath': notice.relative_to(ROOT).as_posix(), 'licenseOwner': owner}


def prepare_family(item, commit):
    directory = CACHE / 'library' / item['id']
    directory.mkdir(parents=True, exist_ok=True)
    notice = directory / 'OFL.txt'
    origin = f'https://raw.githubusercontent.com/google/fonts/{commit}/'
    base.download(origin + quote(item['notice']), notice)
    records = []
    for entry in item['fonts']:
        filename = Path(entry['path']).name
        variable = '[' in filename
        if not variable and not re.search(r'-(Regular|Bold|Italic|BoldItalic)\.ttf$', filename):
            continue
        source = directory / ('source-' + filename)
        data = base.download(origin + quote(entry['path']), source)
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != entry['sha']:
            raise ValueError(f'Pinned font mismatch: {entry["path"]}')
        original = TTFont(source)
        family = original['name'].getDebugName(16) or original['name'].getDebugName(1)
        italic = bool(original['OS/2'].fsSelection & 1) or original['post'].italicAngle != 0
        weights = [400, 700] if 'fvar' in original else [original['OS/2'].usWeightClass]
        for weight in weights:
            style = ('Bold' if weight >= 600 else 'Regular') if not italic else ('Bold Italic' if weight >= 600 else 'Italic')
            identifier = item['id'] + '-' + style.lower().replace(' ', '-')
            destination = directory / (identifier + '.ttf')
            if not destination.exists():
                font = TTFont(source)
                if 'fvar' in font:
                    axes = {axis.axisTag: min(axis.maxValue, max(axis.minValue, weight)) if axis.axisTag == 'wght' else axis.defaultValue for axis in font['fvar'].axes}
                    font = instantiateVariableFont(font, axes, inplace=True)
                names(font, family, style)
                font.recalcTimestamp = False
                font.save(destination)
            records.append(record(destination, identifier, family, style, weight, italic, notice, item['id']))
        original.close()
    print('Prepared', item['id'], len(records), flush=True)
    return records


def main():
    source = json.loads((ROOT / 'resources/font-library.json').read_text(encoding='utf-8'))
    prepared_path = CACHE / 'prepared-fonts.json'
    initial = json.loads(prepared_path.read_text(encoding='utf-8'))
    original_ids = {item['id'] for item in json.loads((ROOT / 'resources/font-assets.json').read_text())['fonts']['families']}
    records = [item for item in initial if item['licenseOwner'] in original_ids and '/library/' not in item['path']]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for group in pool.map(lambda item: prepare_family(item, source['commit']), source['families']):
            records.extend(group)
    for item in source.get('extraFamilies', []):
        asset = item['assets'][0]
        directory = CACHE / 'library' / item['id']
        archive = directory / asset['name']
        data = base.download(asset['url'], archive)
        if asset.get('digest') and 'sha256:' + digest(data) != asset['digest']:
            raise ValueError('Font archive checksum mismatch')
        with zipfile.ZipFile(archive) as package:
            font_names = [name for name in package.namelist() if name.lower().endswith(('.ttf', '.otf')) and not name.startswith('__MACOSX')]
            notice_names = [name for name in package.namelist() if Path(name).name.lower() in ['ofl.txt', 'license.txt', 'license']]
            notice = directory / 'NOTICE.txt'
            if notice_names:
                notice.write_bytes(package.read(notice_names[0]))
            else:
                notice.write_text(f"Source: {item['repository']}\nRelease: {item['tag']}\nFile: {asset['url']}\nOriginal font metadata and copyright notices are retained. Refer to the upstream project for its terms.\n", encoding='utf-8')
            for name in font_names:
                path = directory / Path(name).name
                path.write_bytes(package.read(name))
                font = TTFont(path)
                family = font['name'].getDebugName(16) or font['name'].getDebugName(1)
                style = font['name'].getDebugName(17) or font['name'].getDebugName(2)
                records.append(record(path, item['id'] + '-' + style.lower().replace(' ', '-'), family, style,
                                      font['OS/2'].usWeightClass, bool(font['OS/2'].fsSelection & 1), notice, item['id']))
                font.close()
    for item in list(records):
        if item['italic'] or item['weight'] != 400 or any(other['family'] == item['family'] and other['weight'] >= 600 and not other['italic'] for other in records):
            continue
        identifier = item['id'] + '-bold'
        destination = CACHE / 'library' / 'bold' / (identifier + '.ttf')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            font = TTFont(ROOT / item['path'])
            embolden(font, ROOT / item['path'])
            names(font, item['family'], 'Bold')
            font.recalcTimestamp = False
            font.save(destination)
            font.close()
        records.append(record(destination, identifier, item['family'], 'Bold', 700, False, ROOT / item['licensePath'], item['licenseOwner']))
        print('Prepared bold:', identifier, flush=True)
    # Oblique outline faces keep CJK text in its own family instead of losing glyphs
    # by silently replacing it with a Latin-only italic font.
    for item in list(records):
        if item['italic'] or any(other['family'] == item['family'] and other['weight'] == item['weight'] and other['italic'] for other in records):
            continue
        style = 'Bold Oblique' if item['weight'] >= 600 else 'Oblique'
        identifier = item['id'] + '-oblique'
        destination = CACHE / 'library' / 'oblique' / (identifier + '.' + item['format'])
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            font = TTFont(ROOT / item['path'])
            oblique(font)
            names(font, item['family'], style)
            font.recalcTimestamp = False
            font.save(destination)
            font.close()
        records.append(record(destination, identifier, item['family'], style, item['weight'], True, ROOT / item['licensePath'], item['licenseOwner']))
        print('Prepared oblique:', identifier, flush=True)
    prepared_path.write_text(json.dumps(records, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('Ready:', len({item['family'] for item in records}), 'families,', len(records), 'faces;', sum(item['bytes'] for item in records), 'bytes', flush=True)

if __name__ == '__main__':
    main()
