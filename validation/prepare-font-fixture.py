"""Assemble two prepared, real Liberation faces into a TTC for non-first-face tests."""
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
FACES = [
    ROOT / 'resources/downloads/fonts/liberation-sans/LiberationSans-Regular.ttf',
    ROOT / 'resources/downloads/fonts/liberation-serif/LiberationSerif-Italic.ttf',
]


def prepare():
    collection = bytearray(struct.pack('>4sII', b'ttcf', 0x00010000, len(FACES)))
    collection.extend(bytes(4 * len(FACES)))
    for index, path in enumerate(FACES):
        face = bytearray(path.read_bytes())
        if face[:4] != b'\x00\x01\x00\x00':
            raise ValueError(f'Expected a standalone TrueType fixture: {path.name}')
        collection.extend(bytes((-len(collection)) % 4))
        face_offset = len(collection)
        struct.pack_into('>I', collection, 12 + index * 4, face_offset)
        table_count = struct.unpack_from('>H', face, 4)[0]
        for table in range(table_count):
            entry = 12 + table * 16
            offset = struct.unpack_from('>I', face, entry + 8)[0]
            # TTC table offsets are relative to the collection, not each SFNT.
            struct.pack_into('>I', face, entry + 8, face_offset + offset)
        collection.extend(face)
    destination = ROOT / 'tmp/font-runtime/liberation-two-faces.ttc'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(collection)
    print(f'{destination}: {len(collection)} bytes; face 0=Sans Regular, face 1=Serif Italic')
    return destination


if __name__ == '__main__':
    prepare()
