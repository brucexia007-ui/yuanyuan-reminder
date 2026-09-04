#!/usr/bin/env python3
"""Build deterministic universal and WorkBuddy Skill ZIP packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
PLATFORMS_FILE = SKILL_ROOT / "compat" / "platforms.json"
FIXED_ZIP_TIME = (2026, 9, 4, 0, 0, 0)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_universal(destination: Path) -> None:
    shutil.copytree(
        SKILL_ROOT,
        destination,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )


def copy_workbuddy(destination: Path) -> None:
    destination.mkdir(parents=True)
    shutil.copy2(SKILL_ROOT / "compat" / "workbuddy" / "SKILL.md", destination / "SKILL.md")
    shutil.copytree(SKILL_ROOT / "references", destination / "references")
    shutil.copytree(
        SKILL_ROOT / "assets" / "reference-scenes",
        destination / "references" / "reference-scenes",
    )
    shutil.copy2(
        SKILL_ROOT / "assets" / "REFERENCE_ASSETS_LICENSE.md",
        destination / "references" / "REFERENCE_ASSETS_LICENSE.md",
    )
    scripts = destination / "scripts"
    scripts.mkdir()
    shutil.copy2(SKILL_ROOT / "scripts" / "validate_pack.py", scripts / "validate_pack.py")
    shutil.copy2(SKILL_ROOT / "START_HERE.zh-CN.md", destination / "START_HERE.zh-CN.md")


def write_deterministic_zip(source: Path, output: Path) -> None:
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(item for item in source.rglob("*") if item.is_file()):
            relative = Path(source.name) / path.relative_to(source)
            info = zipfile.ZipInfo(relative.as_posix(), FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)


def build(output_dir: Path) -> list[Path]:
    config = json.loads(PLATFORMS_FILE.read_text(encoding="utf-8"))
    version = str(config["skillVersion"])
    output_dir.mkdir(parents=True, exist_ok=True)
    packages: list[Path] = []

    with tempfile.TemporaryDirectory(prefix="pet-lifestyle-scene-pack-") as temp:
        staging = Path(temp)
        universal_root = staging / "pet-lifestyle-scene-pack"
        copy_universal(universal_root)
        universal_zip = output_dir / f"pet-lifestyle-scene-pack-universal-v{version}.zip"
        write_deterministic_zip(universal_root, universal_zip)
        packages.append(universal_zip)

        shutil.rmtree(universal_root)
        workbuddy_root = staging / "pet-lifestyle-scene-pack"
        copy_workbuddy(workbuddy_root)
        workbuddy_zip = output_dir / f"pet-lifestyle-scene-pack-workbuddy-v{version}.zip"
        write_deterministic_zip(workbuddy_root, workbuddy_zip)
        packages.append(workbuddy_zip)

    checksum_file = output_dir / "SHA256SUMS.txt"
    checksum_file.write_text(
        "".join(f"{sha256_file(path)}  {path.name}\n" for path in packages),
        encoding="utf-8",
        newline="\n",
    )
    return packages + [checksum_file]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build universal and WorkBuddy ZIPs for pet-lifestyle-scene-pack."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory that will receive the two ZIP files and SHA256SUMS.txt.",
    )
    args = parser.parse_args()
    outputs = build(args.output_dir.resolve())
    for output in outputs:
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
