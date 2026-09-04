#!/usr/bin/env python3
"""Validate the reference or generated PNG scene pack without dependencies."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_CANDIDATES = (
    SKILL_ROOT / "assets" / "reference-scenes" / "manifest.json",
    SKILL_ROOT / "references" / "reference-scenes" / "manifest.json",
)
DEFAULT_MANIFEST = next((path for path in MANIFEST_CANDIDATES if path.exists()), MANIFEST_CANDIDATES[0])
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
CUSTOM_SCENE_NAME = re.compile(r"^custom-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.png$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as stream:
        signature = stream.read(8)
        length_bytes = stream.read(4)
        chunk_type = stream.read(4)
        dimensions = stream.read(8)
    if signature != PNG_SIGNATURE:
        raise ValueError("not a PNG file")
    if len(length_bytes) != 4 or struct.unpack(">I", length_bytes)[0] != 13:
        raise ValueError("invalid PNG IHDR length")
    if chunk_type != b"IHDR" or len(dimensions) != 8:
        raise ValueError("missing PNG IHDR")
    width, height = struct.unpack(">II", dimensions)
    if width <= 0 or height <= 0:
        raise ValueError("invalid image dimensions")
    return width, height


def load_manifest(path: Path) -> list[dict[str, object]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    scenes = data.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("manifest must contain a non-empty scenes array")
    filenames = [scene.get("file") for scene in scenes]
    ids = [scene.get("id") for scene in scenes]
    if len(filenames) != len(set(filenames)) or len(ids) != len(set(ids)):
        raise ValueError("manifest scene ids and filenames must be unique")
    return scenes


def validate(args: argparse.Namespace) -> list[str]:
    errors: list[str] = []
    try:
        scenes = load_manifest(args.manifest)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return [f"manifest: {exc}"]

    expected = {str(scene["file"]): scene for scene in scenes}
    if not args.directory.is_dir():
        return [f"target directory does not exist: {args.directory}"]

    actual_paths = sorted(args.directory.glob("*.png"))
    actual_names = {path.name for path in actual_paths}
    expected_names = set(expected)
    missing = sorted(expected_names - actual_names)
    allowed_custom_names = {
        name for name in actual_names if args.allow_custom and CUSTOM_SCENE_NAME.fullmatch(name)
    }
    unexpected = sorted(actual_names - expected_names - allowed_custom_names)

    if missing and not args.allow_subset:
        errors.append("missing scenes: " + ", ".join(missing))
    if args.allow_subset and not (actual_names & expected_names or allowed_custom_names):
        errors.append("subset is empty")
    if unexpected:
        errors.append("unexpected PNG files: " + ", ".join(unexpected))
    if args.check_reference_hashes and args.allow_subset:
        errors.append("--check-reference-hashes cannot be combined with --allow-subset")
    if args.check_reference_hashes and args.allow_custom:
        errors.append("--check-reference-hashes cannot be combined with --allow-custom")

    hashes: dict[str, str] = {}
    for path in actual_paths:
        if path.name not in expected and path.name not in allowed_custom_names:
            continue
        try:
            width, height = png_dimensions(path)
        except (OSError, ValueError) as exc:
            errors.append(f"{path.name}: {exc}")
            continue

        ratio = width / height
        if width >= height:
            errors.append(f"{path.name}: expected portrait orientation, got {width}x{height}")
        if abs(ratio - 0.75) > args.aspect_tolerance:
            errors.append(
                f"{path.name}: aspect ratio {ratio:.6f} is outside "
                f"3:4 tolerance ±{args.aspect_tolerance:.3f}"
            )

        digest = sha256_file(path)
        if digest in hashes:
            errors.append(f"{path.name}: duplicates {hashes[digest]}")
        else:
            hashes[digest] = path.name

        if args.check_reference_hashes and path.name in expected:
            scene = expected[path.name]
            if width != int(scene["width"]) or height != int(scene["height"]):
                errors.append(
                    f"{path.name}: expected {scene['width']}x{scene['height']}, "
                    f"got {width}x{height}"
                )
            if digest.lower() != str(scene["sha256"]).lower():
                errors.append(f"{path.name}: SHA-256 does not match manifest")

    return errors


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate filenames, PNG structure, 3:4 ratio, uniqueness, and reference hashes."
    )
    parser.add_argument(
        "directory",
        nargs="?",
        type=Path,
        default=DEFAULT_MANIFEST.parent,
        help="Directory containing scene PNG files (defaults to the bundled references).",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="Scene manifest to use.",
    )
    parser.add_argument(
        "--allow-subset",
        action="store_true",
        help="Allow any non-empty subset of recognized scene filenames.",
    )
    parser.add_argument(
        "--allow-custom",
        action="store_true",
        help="Allow custom-NN-english-slug.png files in addition to preset scenes.",
    )
    parser.add_argument(
        "--check-reference-hashes",
        action="store_true",
        help="Require the exact dimensions and SHA-256 values recorded in the manifest.",
    )
    parser.add_argument(
        "--aspect-tolerance",
        type=float,
        default=0.02,
        help="Absolute tolerance around width/height = 0.75 (default: 0.02).",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.directory = args.directory.resolve()
    args.manifest = args.manifest.resolve()
    if args.aspect_tolerance < 0:
        parser.error("--aspect-tolerance must be non-negative")

    errors = validate(args)
    if errors:
        print("Scene pack validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    count = len(list(args.directory.glob("*.png")))
    mode = "reference hashes" if args.check_reference_hashes else "scene pack"
    print(f"OK: validated {count} PNG file(s) for {mode} in {args.directory}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
