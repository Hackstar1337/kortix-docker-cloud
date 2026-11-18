#!/usr/bin/env python3
"""Validate the integration payload using only Python's standard library."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SECRET_PATTERNS = [
    re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|dckr_pat_[A-Za-z0-9_-]{20,})'),
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'AKIA[A-Z0-9]{16}'),
]

def safe_relative(value: str) -> PurePosixPath:
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or '\\' in value or not path.parts:
        raise ValueError('Unsafe integration path')
    if path.parts[0] not in ('apps', 'packages') and value != 'pnpm-lock.yaml':
        raise ValueError('Unexpected integration surface')
    return path

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def verify(root: Path = ROOT) -> dict:
    manifest = json.loads((root / 'integration.json').read_text(encoding='utf-8'))
    if not re.fullmatch(r'[0-9a-f]{40}', manifest['upstream_revision']):
        raise ValueError('Upstream must be pinned to a full commit SHA')
    if manifest['upstream_repository'] != 'https://github.com/kortix-ai/CompanyOS.git':
        raise ValueError('Unexpected upstream repository')
    patch = root / manifest['patch']
    if patch.resolve().parent != (root / 'patches').resolve():
        raise ValueError('Patch must be inside patches/')
    if digest(patch) != manifest['patch_sha256']:
        raise ValueError('Patch checksum mismatch')
    paths = []
    for item in manifest['files']:
        relative = safe_relative(item['path'])
        target = root / 'overlay' / str(relative)
        if target.is_symlink() or not target.is_file():
            raise ValueError('Missing or symlinked integration file')
        if digest(target) != item['sha256']:
            raise ValueError('Overlay checksum mismatch: ' + item['path'])
        paths.append(item['path'])
    if len(set(paths)) != len(paths):
        raise ValueError('Duplicate manifest path')
    sections = re.findall(r'^diff --git a/(\S+) b/(\S+)$', patch.read_text(encoding='utf-8'), re.M)
    if any(a != b for a, b in sections) or sorted(b for _, b in sections) != sorted(paths):
        raise ValueError('Patch and overlay inventories differ')
    actual = sorted(str(p.relative_to(root / 'overlay')).replace('\\', '/') for p in (root / 'overlay').rglob('*') if p.is_file())
    if actual != sorted(paths):
        raise ValueError('Unlisted overlay files')
    if not (root / 'LICENSE').read_text(encoding='utf-8').startswith('Elastic License 2.0'):
        raise ValueError('Upstream license is missing or changed')
    scanned = 0
    for p in root.rglob('*'):
        rel = p.relative_to(root)
        if any(part in ('.git', '.work', 'node_modules', '__pycache__') for part in rel.parts) or not p.is_file():
            continue
        if p.is_symlink():
            raise ValueError('Public kit must not contain symlinks')
        if (p.name == '.env' or p.name.endswith('.env')) and not p.name.endswith('.example'):
            raise ValueError('Private environment file in public payload')
        data = p.read_bytes()
        if any(pattern.search(data) for pattern in SECRET_PATTERNS):
            raise ValueError('Credential-like material in public payload: ' + str(rel))
        scanned += 1
    return {'overlay_files': len(paths), 'scanned_files': scanned, 'patch_sha256': digest(patch)}

if __name__ == '__main__':
    try:
        print(json.dumps(verify(), indent=2))
    except (ValueError, KeyError, OSError) as error:
        print('Verification failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
