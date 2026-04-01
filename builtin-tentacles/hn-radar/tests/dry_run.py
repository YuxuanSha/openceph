#!/usr/bin/env python3
"""
hn-radar deployment verification script.
Run from the tentacle directory: venv/bin/python tests/dry_run.py
"""

import subprocess
import sys
import os

def main():
    tentacle_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run(
        [os.path.join(tentacle_dir, "venv", "bin", "python"), "src/main.py", "--dry-run"],
        cwd=tentacle_dir,
        capture_output=True,
        text=True,
        timeout=30,
    )
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    sys.exit(result.returncode)

if __name__ == "__main__":
    main()