#!/usr/bin/env python3
"""Check the Ghost executable's identity and customer command interface."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='ghost-check-') as directory:
    staged = Path(directory) / ('ghost.exe' if os.name == 'nt' else 'ghost')
    shutil.copy2(binary, staged)
    env = dict(os.environ, PATH=directory)
    env.pop('_GHOST_EXTENSION_DISPATCHED', None)
    version = subprocess.run([str(staged), '--version'], env=env, capture_output=True, check=True)
    if not version.stdout.startswith(b'ghost '):
        raise SystemExit('Unexpected Ghost identity')
    for command in ('key', 'account', 'backup', 'provider'):
        result = subprocess.run([str(staged), command, '--help'], env=env, capture_output=True, check=True)
        if b'Usage:' not in result.stdout:
            raise SystemExit('Missing customer command help')
