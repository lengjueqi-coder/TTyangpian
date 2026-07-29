#!/usr/bin/env python3
"""Fail a release if tracked runtime state, caches, secrets, or build output leak in."""
from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
FORBIDDEN_PARTS = {
    '__pycache__', '.pytest_cache', '.playwright-cli', '.uploads', '.DS_Store',
    'logs', 'backups', 'models', 'output', 'outputs', '_运行缓存', '_成品输出',
    '_代码备份', 'build', 'dist', 'build_venv', 'venv', '.venv',
}
FORBIDDEN_PREFIXES = ('data/', 'static/images/', 'rh_smoke_')
SECRET_PATTERNS = (
    re.compile(r'github_pat_[A-Za-z0-9_]{20,}'),
    re.compile(r'ghp_[A-Za-z0-9]{20,}'),
    re.compile(r'\bsk-[A-Za-z0-9_-]{20,}'),
)


def tracked_files() -> list[pathlib.Path]:
    output = subprocess.check_output(
        ['git', 'ls-files'], cwd=ROOT, text=True, encoding='utf-8'
    )
    return [pathlib.Path(line) for line in output.splitlines() if line]


def main() -> int:
    errors: list[str] = []
    for rel in tracked_files():
        posix = rel.as_posix()
        if any(part in FORBIDDEN_PARTS for part in rel.parts):
            errors.append(f'forbidden tracked path: {posix}')
        if posix.startswith(FORBIDDEN_PREFIXES):
            errors.append(f'forbidden tracked prefix: {posix}')
        path = ROOT / rel
        if not path.is_file() or path.stat().st_size > 2_000_000:
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                errors.append(f'possible credential in {posix}: {pattern.pattern}')

    config = ROOT / 'default_data' / 'model_config.json'
    if config.exists():
        payload = json.loads(config.read_text(encoding='utf-8'))
        for key in ('api_key', 'rh_api_key', 'oaihk_api_key'):
            if str(payload.get(key) or '').strip():
                errors.append(f'default_data/model_config.json contains non-empty {key}')

    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print('RELEASE_TREE_OK')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
