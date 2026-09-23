"""Prepare the six pinned font families; publish only formats connected to the core."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import struct
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'resources/downloads/fonts'


def download(url, destination):
    if destination.is_file():
        return destination.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.download', delete=False) as output:
        temporary = Path(output.name)
        try:
            with urllib.request.urlopen(url, timeout=90) as response:
                shutil.copyfileobj(response, output, 1024 * 1024)
        except BaseException:
            output.close()
            temporary.unlink()
            raise
    temporary.replace(destination)
    return destination.read_bytes()


def verify(data, entry):
    digest = hashlib.sha256(data).hexdigest()
    if entry.get('byteSize') and len(data) != entry['byteSize']:
        raise ValueError(f"Unexpected size: {entry['fileName']}")
    if entry.get('sha256') and digest != entry['sha256']:
        raise ValueError(f"SHA-256 mismatch: {entry['fileName']}")
    if entry.get('upstreamGitBlobSha1'):
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        if blob != entry['upstreamGitBlobSha1']:
            raise ValueError(f"Pinned Git blob mismatch: {entry['fileName']}")
    return digest


def sfnt(data):
    if len(data) < 12 or data[:4] not in (b'\x00\x01\x00\x00', b'OTTO'):
        raise ValueError('Expected a standalone TrueType or OpenType font')
    count = struct.unpack_from('>H', data, 4)[0]
    if 12 + count * 16 > len(data):
        raise ValueError('Invalid SFNT directory')
    for index in range(count):
        tag, _, offset, length = struct.unpack_from('>4sIII', data, 12 + index * 16)
        if offset + length > len(data):
            raise ValueError('SFNT table extends past the file')
        if tag == b'OS/2':
            if length < 10:
                raise ValueError('Incomplete OS/2 table')
            version = struct.unpack_from('>H', data, offset)[0]
            fs_type = struct.unpack_from('>H', data, offset + 8)[0]
            editable = version <= 5 and not (fs_type & ~0x030E) and (fs_type & 0xE) in (0, 8) and not (fs_type & 0x200)
            return {'format': 'otf' if data[:4] == b'OTTO' else 'ttf', 'fsType': fs_type, 'editableEmbedding': bool(editable)}
    raise ValueError('Missing OS/2 embedding information')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publish-ttf', action='store_true', help='publish the currently supported TrueType families to web assets')
    parser.add_argument('--publish-all', action='store_true', help='use only after OpenType/CFF editing is connected')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'resources/font-assets.json').read_text(encoding='utf-8'))
    families = manifest['fonts']['families']
    by_id = {family['id']: family for family in families}
    records = []
    for family in families:
        license_owner = family
        if 'licenseRef' in family:
            license_owner = by_id[family['licenseRef'].split('[', 1)[1].split(']', 1)[0]]
        license_path = CACHE / license_owner['id'] / 'OFL.txt'
        download(license_owner['license']['url'], license_path)
        archive = family.get('sourceArchive')
        if 'sourceArchiveRef' in family:
            archive = by_id[family['sourceArchiveRef'].split('[', 1)[1].split(']', 1)[0]]['sourceArchive']
        archive_path = None
        if archive:
            archive_path = CACHE / '_archives' / archive['fileName']
            verify(download(archive['url'], archive_path), archive)
        for entry in family['files']:
            destination = CACHE / family['id'] / entry['fileName']
            if not destination.is_file() and archive_path:
                with tarfile.open(archive_path, 'r:gz') as package:
                    members = [member for member in package.getmembers() if member.isfile() and Path(member.name).name == entry['fileName']]
                    if len(members) != 1:
                        raise ValueError(f"Archive member missing or ambiguous: {entry['fileName']}")
                    data = package.extractfile(members[0]).read()
                verify(data, entry)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            data = destination.read_bytes() if destination.is_file() else download(entry['url'], destination)
            digest = verify(data, entry)
            info = sfnt(data)
            if not info['editableEmbedding']:
                raise ValueError(f"Font does not permit editable embedding: {entry['fileName']}")
            record = {'id': family['id'] + '-' + entry['style'].lower().replace(' ', '-'),
                      'family': family['familyName'], 'style': entry['style'], 'weight': entry['weight'],
                      'italic': entry.get('italic', False), **info, 'sha256': digest, 'bytes': len(data),
                      'path': destination.relative_to(ROOT).as_posix(),
                      'licensePath': license_path.relative_to(ROOT).as_posix(), 'licenseOwner': license_owner['id']}
            records.append(record)
            print(f"Prepared {record['id']} ({info['format']}, {len(data)} bytes)", flush=True)
    (CACHE / 'prepared-fonts.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    if args.publish_ttf or args.publish_all:
        public = ROOT / 'apps/web/public/fonts'
        public.mkdir(parents=True, exist_ok=True)
        resources = []
        for record in records:
            if record['format'] != 'ttf' and not args.publish_all:
                continue
            source = ROOT / record['path']
            filename = f"{source.stem}.{record['sha256'][:16]}{source.suffix}"
            license_name = 'LXGW-WenKai-OFL.txt' if record['licenseOwner'] == 'lxgw-wenkai' else record['licenseOwner'] + '-OFL.txt'
            shutil.copy2(source, public / filename)
            shutil.copy2(ROOT / record['licensePath'], public / license_name)
            resources.append({key: record[key] for key in ('id', 'family', 'style', 'weight', 'italic', 'format', 'sha256')}
                             | {'url': '/fonts/' + filename, 'licenseUrl': '/fonts/' + license_name})
        (public / 'font-resources.json').write_text(json.dumps(resources, indent=2) + '\n', encoding='utf-8')
        print(f'Published {len(resources)} font faces; unsupported formats remain in the prepared asset cache.')


if __name__ == '__main__':
    main()
