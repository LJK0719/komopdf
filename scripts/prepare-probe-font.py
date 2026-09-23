"""Prepare the locked OFL TrueType font used by the native CJK writeback probe."""
from pathlib import Path
import argparse
import shutil
import hashlib
import json
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NAME = 'LXGWWenKai-Regular.ttf'

def find_asset(value):
    if isinstance(value, dict):
        if value.get('fileName') == NAME:
            return value
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return None
    for child in children:
        found = find_asset(child)
        if found:
            return found
    return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publish-web', action='store_true', help='publish this verified font and its license for the browser editor')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'resources/font-assets.json').read_text(encoding='utf-8'))
    asset = find_asset(manifest)
    if asset is None or not asset.get('sha256'):
        raise ValueError('A pinned font digest is required')
    target = ROOT / 'resources/downloads/fonts/lxgw-wenkai' / NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with urllib.request.urlopen(asset['url'], timeout=60) as response, target.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
    data = target.read_bytes()
    if len(data) != asset['byteSize'] or hashlib.sha256(data).hexdigest() != asset['sha256']:
        raise ValueError('Font does not match the pinned release digest/size')
    print(f'Verified {target.relative_to(ROOT)} ({len(data)} bytes)')
    if args.publish_web:
        family = next(item for item in manifest['fonts']['families'] if item['id'] == 'lxgw-wenkai')
        license_file = target.parent / 'OFL.txt'
        if not license_file.exists():
            with urllib.request.urlopen(family['license']['url'], timeout=30) as response:
                license_file.write_bytes(response.read())
        destination = ROOT / 'apps/web/public/fonts'
        destination.mkdir(parents=True, exist_ok=True)
        filename = f'LXGWWenKai-Regular.{asset["sha256"][:16]}.ttf'
        shutil.copy2(target, destination / filename)
        shutil.copy2(license_file, destination / 'LXGW-WenKai-OFL.txt')
        resources = [{ 'id': 'lxgw-wenkai-regular', 'family': 'LXGW WenKai', 'style': 'Regular',
                       'format': 'ttf', 'url': '/fonts/' + filename, 'sha256': asset['sha256'] }]
        (destination / 'font-resources.json').write_text(json.dumps(resources, indent=2) + '\n', encoding='utf-8')
        print('Published the verified font and original OFL license for local browser use')

if __name__ == '__main__':
    main()
