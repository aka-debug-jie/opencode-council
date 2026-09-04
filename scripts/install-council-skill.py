#!/usr/bin/env python3
"""Install or check only this checkout's managed codex-council skill files."""

import argparse
import os
from pathlib import Path
import shutil
import sys


SOURCE = Path(__file__).resolve().parents[1] / "skills" / "codex-council"


def source_files():
    return sorted(
        path for path in SOURCE.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
    )


def managed_target(destination, relative):
    target = destination / relative
    for path in (target, *target.parents):
        if path.is_symlink():
            raise ValueError(f"Refusing a symlink in the managed skill path: {path}")
        if path == destination:
            break
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Read-only comparison of managed files")
    parser.add_argument(
        "--destination", type=Path,
        default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "skills" / "codex-council",
        help="Target skill directory (default: $CODEX_HOME/skills/codex-council)",
    )
    args = parser.parse_args()
    destination = args.destination.expanduser().absolute()
    files = source_files()
    if not files or not (SOURCE / "SKILL.md").is_file():
        raise ValueError(f"Repository skill source is missing: {SOURCE}")

    # Preflight every managed target before changing any destination file.
    pairs = [(source, managed_target(destination, source.relative_to(SOURCE))) for source in files]
    differences = []
    for source, target in pairs:
        relative = source.relative_to(SOURCE)
        if args.check:
            if not target.is_file():
                differences.append(f"missing: {relative}")
            elif target.read_bytes() != source.read_bytes():
                differences.append(f"different: {relative}")
            elif (target.stat().st_mode & 0o111) != (source.stat().st_mode & 0o111):
                differences.append(f"executable mode differs: {relative}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    if differences:
        print("\n".join(differences), file=sys.stderr)
        return 1
    action = "Checked" if args.check else "Installed"
    print(f"{action} {len(files)} managed files: {destination}")
    print("Unmanaged files and unrelated configuration are unchanged.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"Council skill installation failed: {error}", file=sys.stderr)
        raise SystemExit(2)
