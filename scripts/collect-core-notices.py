#!/usr/bin/env python3
"""Collect pinned native notices, or verify committed notices without build caches."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
PDFIUM_NOTICES = {
    'pdfium-LICENSE.txt': 'LICENSE',
    'pdfium-AUTHORS.txt': 'AUTHORS',
    'abseil-cpp-LICENSE.txt': 'third_party/abseil-cpp/LICENSE',
    'abseil-cpp-AUTHORS.txt': 'third_party/abseil-cpp/AUTHORS',
    'agg23-copying.txt': 'third_party/agg23/copying',
    'freetype-FTL.txt': 'third_party/freetype/FTL.TXT',
    'freetype-LICENSE.txt': 'third_party/freetype/src/LICENSE.TXT',
    'harfbuzz-COPYING.txt': 'third_party/harfbuzz/src/COPYING',
    'harfbuzz-AUTHORS.txt': 'third_party/harfbuzz/src/AUTHORS',
    'icu-LICENSE.txt': 'third_party/icu/LICENSE',
    'lcms-LICENSE.txt': 'third_party/lcms/LICENSE',
    'libjpeg_turbo-LICENSE.md': 'third_party/libjpeg_turbo/LICENSE.md',
    'libjpeg_turbo-README.ijg.txt': 'third_party/libjpeg_turbo/README.ijg',
    'libopenjpeg-LICENSE.txt': 'third_party/libopenjpeg/LICENSE',
    'zlib-LICENSE.txt': 'third_party/zlib/LICENSE',
}
PROJECT_NOTICES = {
    'qpdf-LICENSE.txt': 'native/qpdf/artifacts/wasm/licenses/qpdf-LICENSE.txt',
    'qpdf-libjpeg-README.txt': 'native/qpdf/artifacts/wasm/licenses/libjpeg-README.txt',
    'qpdf-zlib-LICENSE.txt': 'native/qpdf/artifacts/wasm/licenses/zlib-LICENSE.txt',
    'font-liberation-OFL.txt': 'apps/web/public/fonts/liberation-sans-OFL.txt',
    'font-lxgw-wenkai-OFL.txt': 'apps/web/public/fonts/LXGW-WenKai-OFL.txt',
    'font-noto-sans-cjk-sc-OFL.txt': 'apps/web/public/fonts/noto-sans-cjk-sc-OFL.txt',
    'font-noto-serif-cjk-sc-OFL.txt': 'apps/web/public/fonts/noto-serif-cjk-sc-OFL.txt',
}
EMSCRIPTEN_NOTICES = {
    'emscripten-LICENSE.txt': 'LICENSE',
    'musl-COPYRIGHT.txt': 'system/lib/libc/musl/COPYRIGHT',
    'libcxx-LICENSE.txt': 'system/lib/libcxx/LICENSE.TXT',
    'libcxxabi-LICENSE.txt': 'system/lib/libcxxabi/LICENSE.TXT',
    'compiler-rt-LICENSE.txt': 'system/lib/compiler-rt/LICENSE.TXT',
    'llvm-libc-LICENSE.txt': 'system/lib/llvm-libc/LICENSE.TXT',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, default=ROOT / 'native/vendor/sources/pdfium-wasm')
    parser.add_argument('--emscripten-root', type=Path, default=ROOT / 'native/vendor/tools/emsdk/upstream/emscripten')
    parser.add_argument('--dest-dir', type=Path, default=ROOT / 'third_party/notices')
    parser.add_argument('--check', action='store_true', help='Verify committed files against the notice manifest; no source caches needed')
    args = parser.parse_args()
    manifest_file = args.dest_dir / 'manifest.json'
    if args.check:
        records = json.loads(manifest_file.read_text(encoding='utf-8'))['notices']
        for name, record in records.items():
            data = (args.dest_dir / name).read_bytes()
            if len(data) != record['bytes'] or digest(data) != record['sha256']:
                raise ValueError(f'Notice integrity mismatch: {name}')
        print(f'Verified {len(records)} committed notice files without native build caches.')
        return
    records = {}
    inputs = []
    for base, label, mapping in (
        (args.source_root, 'pdfium-wasm', PDFIUM_NOTICES),
        (args.emscripten_root, 'emscripten', EMSCRIPTEN_NOTICES),
        (ROOT, 'project', PROJECT_NOTICES),
    ):
        for name, relative in mapping.items():
            source = base / relative
            data = source.read_bytes()
            records[name] = {'source': f'{label}/{relative}', 'sha256': digest(data), 'bytes': len(data)}
            inputs.append((source, args.dest_dir / name))
    args.dest_dir.mkdir(parents=True, exist_ok=True)
    for source, target in inputs:
        shutil.copy2(source, target)
    manifest_file.write_text(json.dumps({'schemaVersion': 1, 'notices': records}, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'Collected {len(records)} source notice files. This is not a legal clearance.')


if __name__ == '__main__':
    main()
