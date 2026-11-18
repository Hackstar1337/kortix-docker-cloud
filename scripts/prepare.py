#!/usr/bin/env python3
"""Prepare a clean pinned Kortix source tree; never touch a live deployment."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import subprocess
import sys
from verify import ROOT, verify, safe_relative, digest


def git(target: Path, *args: str) -> str:
    completed = subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'safe.directory='+str(target), '-C', str(target), *args], check=True, capture_output=True, text=True)
    return completed.stdout.strip()


def prepare(target: Path, root: Path = ROOT) -> Path:
    verify(root)
    manifest = json.loads((root / 'integration.json').read_text(encoding='utf-8'))
    target = target.absolute()
    if target.is_symlink():
        raise ValueError('Target must not be a symlink')
    target = target.resolve()
    if target == root.resolve() or target in root.resolve().parents:
        raise ValueError('Target cannot be the kit or a parent of the kit')
    revision = manifest['upstream_revision']
    if not target.exists():
        target.mkdir(parents=True)
        git(target, 'init')
        git(target, 'remote', 'add', 'origin', manifest['upstream_repository'])
        git(target, 'fetch', '--depth=1', 'origin', revision)
        git(target, 'checkout', '--detach', revision)
    if not (target / '.git').exists():
        raise ValueError('Existing target is not a Git working tree')
    if git(target, 'rev-parse', 'HEAD') != revision:
        raise ValueError('Target is not the tested upstream revision; refusing to patch')
    for item in manifest['files']:
        destination = target / str(safe_relative(item['path']))
        if destination.is_symlink() or not destination.resolve().is_relative_to(target):
            raise ValueError('Unsafe or symlinked destination')
    marker = target / '.kortix-docker-cloud-integration.json'
    if marker.exists():
        state = json.loads(marker.read_text(encoding='utf-8'))
        if state.get('patch_sha256') != manifest['patch_sha256']:
            raise ValueError('A different integration patch is already applied')
        for item in manifest['files']:
            if digest(target / item['path']) != item['sha256']:
                raise ValueError('Prepared source has changed; use a fresh target')
        print('Existing prepared source verified.')
        return target
    if git(target, 'status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Target has local changes; refusing to overwrite them')
    patch = root / manifest['patch']
    git(target, 'apply', '--check', str(patch))
    git(target, 'apply', str(patch))
    for item in manifest['files']:
        if digest(target / item['path']) != item['sha256']:
            raise ValueError('Applied patch differs from reviewed overlay')
    marker.write_text(json.dumps({'upstream_revision': revision, 'patch_sha256': manifest['patch_sha256']}, indent=2) + '\n', encoding='utf-8')
    print('Prepared pinned source: ' + str(target))
    return target

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, required=True, help='New directory or clean checkout at the pinned revision')
    args = parser.parse_args()
    try:
        prepare(args.target)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Preparation refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
