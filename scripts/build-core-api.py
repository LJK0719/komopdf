"""Build the shared C ABI with the prepared native and WASM PDFium toolchains."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / 'native/pdf-core/api'
FONT_PATCH = ROOT / 'native/vendor/patches/0003-opentype-font-subsetting.patch'
FONT_CODE_PATCH = ROOT / 'native/vendor/patches/0004-font-code-mapping.patch'
TEXT_SPACING_PATCH = ROOT / 'native/vendor/patches/0005-text-spacing.patch'
CORE_PATCHES = (FONT_PATCH, FONT_CODE_PATCH, TEXT_SPACING_PATCH)
spec = importlib.util.spec_from_file_location('native_build', Path(__file__).with_name('prepare-native.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

EXPORTS = [
    'pde_abi_version', 'pde_capabilities', 'pde_initialize', 'pde_shutdown', 'pde_open_memory',
    'pde_open_file_utf8', 'pde_close', 'pde_document_info', 'pde_describe_page',
    'pde_extract_page', 'pde_render', 'pde_save_memory', 'pde_save_file_utf8',
    'pde_extract_pages_memory', 'pde_extract_pages_file_utf8',
    'pde_binary_data', 'pde_binary_size', 'pde_error_code', 'pde_error_message',
    'pde_text_edit_stride', 'pde_register_truetype_font', 'pde_font_faces', 'pde_register_font', 'pde_preview_text',
    'pde_apply_text', 'pde_undo', 'pde_redo',
    'pde_edit_command_stride', 'pde_register_rgba_image', 'pde_register_pdf_resource',
    'pde_preview_commands', 'pde_apply_commands', 'pde_confirm_save', 'pde_preview_text_insert',
    'pde_export_recovery', 'pde_export_recovery_file_utf8', 'pde_recovery_resources', 'pde_restore_recovery',
    'pde_restore_recovery_file_utf8', 'pde_describe_forms', 'pde_describe_annotations', 'pde_describe_outline',
    'malloc', 'free',
]

def run(args, cwd, env):
    print('+', subprocess.list2cmdline([str(arg) for arg in args]), flush=True)
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)

def api_sources():
    return sorted([*API.glob('*.cc'), *API.glob('*.h'), API / 'BUILD.gn'])

def bridge_sources():
    bridge = ROOT / 'native/pdf-core/pdfium'
    return sorted([*bridge.glob('*.cc'), *bridge.glob('*.h')])

def copy_api(source):
    for relative, marker, patch in (
        ('core/fpdfapi/edit/cpdf_fontsubsetter.cpp', 'Read either representation without relabeling live font descriptors.', FONT_PATCH),
        ('core/fpdfapi/edit/cpdf_fontsubsetter.cpp', 'candidate.char_code_to_width[width_code]', FONT_CODE_PATCH),
        ('core/fpdfapi/edit/cpdf_pagecontentgenerator.cpp', 'Preserve spacing when regenerating or splitting a text object.', TEXT_SPACING_PATCH),
    ):
        if marker not in (source / relative).read_text(encoding='utf-8'):
            subprocess.run(['git', 'apply', '--check', str(patch)], cwd=source, check=True)
            subprocess.run(['git', 'apply', str(patch)], cwd=source, check=True)
    overlay = source / 'pdf_editor_api'
    overlay.mkdir(exist_ok=True)
    for path in api_sources():
        shutil.copy2(path, overlay / path.name)
    bridge = source / 'pdf_editor_bridge'
    bridge.mkdir(exist_ok=True)
    for path in bridge_sources():
        shutil.copy2(path, bridge / path.name)
    return overlay

def use_embedded_icu(output):
    # Break iteration needs ICU data, not the default external-data stub. Embed
    # the pinned data in every target so layout works offline without a side file.
    path = output / 'args.gn'
    original = path.read_text(encoding='utf-8')
    lines = [line for line in original.splitlines() if not re.match(r'^\s*icu_use_data_file\s*=', line)]
    updated = '\n'.join([*lines, 'icu_use_data_file = false', ''])
    if updated != original:
        path.write_text(updated, encoding='utf-8', newline='\n')

def build_windows(font_tests=False):
    source = ROOT / 'native/vendor/sources/pdfium'
    output = source / 'out/win-x64-release'
    use_embedded_icu(output)
    env = native.confined_environment(ROOT / 'native/vendor/tools/depot_tools')
    env['vs2026_install'] = str(native.VS_PATH)
    env['GYP_MSVS_OVERRIDE_PATH'] = str(native.VS_PATH)
    env['PDF_EDITOR_DEBUGGERS_ROOT'] = str(ROOT / 'native/vendor/tools/windows-debuggers')
    copy_api(source)
    gn = ROOT / 'native/vendor/tools/gn/gn.exe'
    ninja = ROOT / 'native/vendor/tools/ninja/ninja.exe'
    run([gn, 'gen', output, '--root-target=//pdf_editor_api'], source, env)
    run([ninja, '-C', output, '-j4', 'pdf_editor_api_test'], source, env)
    test_args = []
    if font_tests:
        run([sys.executable, ROOT / 'validation/prepare-font-fixture.py'], ROOT, env)
        test_args = [
            '--font-ttf', ROOT / 'resources/downloads/fonts/liberation-sans/LiberationSans-Regular.ttf',
            '--font-otf', ROOT / 'resources/downloads/fonts/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf',
            '--font-ttc', ROOT / 'tmp/font-runtime/liberation-two-faces.ttc', '--ttc-face', '1',
        ]
    run([output / 'pdf_editor_api_test.exe', *test_args], output, env)

def wasm_environment():
    env = os.environ.copy()
    work = ROOT / 'tmp/m0-wasm'
    sdk = ROOT / 'native/vendor/tools/emsdk'
    for variable, subdir in {'HOME': 'home', 'USERPROFILE': 'home', 'TEMP': 'temp', 'TMP': 'temp',
                            'LOCALAPPDATA': 'local-app-data', 'APPDATA': 'roaming-app-data',
                            'XDG_CACHE_HOME': 'cache', 'EM_CACHE': 'cache/emscripten'}.items():
        directory = work / subdir
        directory.mkdir(parents=True, exist_ok=True)
        env[variable] = str(directory)
    env.update(EMSDK=sdk.as_posix(), EM_CONFIG=str(sdk / '.emscripten'),
               EMSDK_NODE=str(sdk / 'node/24.19.0_64bit/node.exe'),
               EMSDK_PYTHON=str(sdk / 'python/3.13.3_64bit/python.exe'))
    paths = [sdk, ROOT / 'native/vendor/tools/depot_tools', sdk / 'upstream/emscripten',
             sdk / 'upstream/bin', Path(env['EMSDK_NODE']).parent, Path(env['EMSDK_PYTHON']).parent]
    env['PATH'] = os.pathsep.join([*(str(path) for path in paths), env.get('PATH', '')])
    return env

def build_wasm():
    source = ROOT / 'native/vendor/sources/pdfium-wasm'
    output = source / 'out/wasm-release'
    use_embedded_icu(output)
    env = wasm_environment()
    overlay = copy_api(source)
    flags = ['--no-entry', '-fexceptions', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
             '-sENVIRONMENT=web,worker', '-sALLOW_MEMORY_GROWTH=1',
             '-sMAXIMUM_MEMORY=1073741824', '-sINITIAL_MEMORY=67108864',
             '-sEXPORTED_RUNTIME_METHODS=' + json.dumps(['HEAPU8'], separators=(',', ':')),
             '-sEXPORTED_FUNCTIONS=' + json.dumps(['_' + name for name in EXPORTS], separators=(',', ':'))]
    # This target shares the API source_set and the exact PDFium toolchain.
    with (overlay / 'BUILD.gn').open('a', encoding='utf-8', newline='\n') as build:
        build.write('\nexecutable("pdf_core_runtime") {\n  output_name = "pdf-core-runtime"\n  output_extension = "js"\n')
        build.write('  deps = [ ":pdf_editor_api", "//:pdfium" ]\n  ldflags = [\n')
        for flag in flags:
            build.write('    ' + json.dumps(flag) + ',\n')
        build.write('  ]\n}\n')
    gn = ROOT / 'native/vendor/tools/gn/gn.exe'
    ninja = ROOT / 'native/vendor/tools/ninja/ninja.exe'
    run([gn, 'gen', output, '--root-target=//pdf_editor_api'], source, env)
    run([ninja, '-C', output, '-j4', 'pdf_core_runtime'], source, env)
    artifacts = [output / 'pdf-core-runtime.js', output / 'pdf-core-runtime.wasm']
    digest = hashlib.sha256()
    digest.update((ROOT / 'native/wasm/wasm-lock.json').read_bytes())
    for path in [*api_sources(), *bridge_sources(), *CORE_PATCHES, overlay / 'BUILD.gn', *artifacts]:
        digest.update(path.read_bytes())
    build_id = 'pdfium-80fccd-abi3-' + digest.hexdigest()[:20]
    destination = ROOT / 'native/wasm/artifacts'
    destination.mkdir(parents=True, exist_ok=True)
    runtime = artifacts[0].read_text(encoding='utf-8')
    (destination / artifacts[0].name).write_text(runtime + '\nexport const PDF_CORE_BUILD_ID = ' + json.dumps(build_id) + ';\n', encoding='utf-8', newline='\n')
    shutil.copy2(artifacts[1], destination / artifacts[1].name)
    metadata = {'abiVersion': 3, 'coreBuildId': build_id, 'pdfiumCommit': native.PDFIUM_COMMIT,
                'files': {path.name: {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                          for path in (destination / artifact.name for artifact in artifacts)}}
    (ROOT / 'native/wasm/runtime-build.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    web = ROOT / 'apps/web/public/engines'
    web.mkdir(parents=True, exist_ok=True)
    for artifact in artifacts:
        shutil.copy2(destination / artifact.name, web / artifact.name)
    print(json.dumps(metadata, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', choices=['windows', 'wasm', 'all'], default='all')
    parser.add_argument('--font-tests', action='store_true', help='Exercise prepared TTF/CFF fonts and a real two-face TTC')
    args = parser.parse_args()
    if args.target in ('windows', 'all'):
        build_windows(args.font_tests)
    if args.target in ('wasm', 'all'):
        build_wasm()
