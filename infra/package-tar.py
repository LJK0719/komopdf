#!/usr/bin/env python3
"""Archive a Linux production tree without flattening pnpm dependency links."""
from pathlib import Path
import sys
import tarfile


def package_release(stage_dir, tar_path):
    stage = Path(stage_dir).resolve()
    target = Path(tar_path).resolve()
    if not stage.is_dir():
        raise ValueError(f'Source directory not found: {stage}')
    if target.exists():
        raise FileExistsError(f'Target archive already exists: {target}')
    if target.is_relative_to(stage):
        raise ValueError('The archive must be outside its input directory')

    def include(member):
        name = Path(member.name)
        if name.is_absolute() or '..' in name.parts:
            raise ValueError(f'Invalid archive member: {member.name}')
        if member.issym():
            # pnpm uses ../ links within node_modules; these are valid. Reject only
            # links escaping the complete release or referring to missing files.
            source = stage / member.name
            resolved = source.resolve(strict=True)
            if not resolved.is_relative_to(stage):
                raise ValueError(f'Dependency link leaves release: {member.name}')
            if Path(member.linkname).is_absolute():
                raise ValueError(f'Non-portable absolute link: {member.name}')
        if member.name.endswith('.sh'):
            member.mode = 0o755
        return member

    with tarfile.open(target, 'w:gz', dereference=False) as archive:
        for item in sorted(stage.iterdir()):
            archive.add(item, arcname=item.name, filter=include)
    print(f'Packaged production dependency graph: {target} ({target.stat().st_size:,} bytes)')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: package-tar.py <stage_dir> <output_tar_gz>')
    package_release(sys.argv[1], sys.argv[2])
