from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw


CELL_WIDTH = 192
CELL_HEIGHT = 208
FRAME_COUNT = 8
SHEETS = (
    ("standard", "spritesheet.webp", (
        "idle", "running-right", "running-left", "waving", "jumping",
        "failed", "waiting", "running", "review", "look-000-157", "look-180-337",
    )),
    ("sleep", "sleep-atlas.webp", ("sleep-enter", "sleeping", "wake-up")),
    ("life", "life-atlas.webp", (
        "grooming-face", "grooming-chest", "grooming-flank", "stretching", "yawning",
        "meowing", "belly-up-down", "focus-calm", "eating-food", "drinking-water",
        "treat-follow", "wand-play", "pet-nuzzle", "ball-bat", "wand-reach",
        "wand-swipe", "wand-return", "ball-pickup", "ball-carry", "ball-drop",
        "alert-glass-paws",
    )),
    ("learning", "learning-atlas.webp", (
        "learning-study-sit", "learning-study-curious", "learning-press-correct",
        "learning-press-wrong",
    )),
)
DIRECTIONS = (
    ("000", "up"), ("022.5", "up-right"), ("045", "up-right"),
    ("067.5", "up-right"), ("090", "right"), ("112.5", "down-right"),
    ("135", "down-right"), ("157.5", "down-right"), ("180", "down"),
    ("202.5", "down-left"), ("225", "down-left"), ("247.5", "down-left"),
    ("270", "left"), ("292.5", "up-left"), ("315", "up-left"),
    ("337.5", "up-left"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def checkerboard(width: int, height: int, tile: int = 12) -> Image.Image:
    image = Image.new("RGBA", (width, height), (240, 242, 245, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, min(width - 1, x + tile - 1), min(height - 1, y + tile - 1)), fill=(216, 221, 228, 255))
    return image


def cells(atlas: Image.Image, row_count: int) -> list[list[Image.Image]]:
    return [
        [
            atlas.crop((column * CELL_WIDTH, row * CELL_HEIGHT, (column + 1) * CELL_WIDTH, (row + 1) * CELL_HEIGHT))
            for column in range(FRAME_COUNT)
        ]
        for row in range(row_count)
    ]


def inspect_cell(cell: Image.Image, sheet: str, row: int, column: int, used: bool) -> dict[str, object]:
    rgba = cell.convert("RGBA")
    alpha = rgba.getchannel("A")
    bbox = alpha.getbbox()
    corners = ((0, 0), (CELL_WIDTH - 1, 0), (0, CELL_HEIGHT - 1), (CELL_WIDTH - 1, CELL_HEIGHT - 1))
    transparent_corners = all(alpha.getpixel(point) == 0 for point in corners)
    pixels = list(rgba.get_flattened_data())
    hidden_rgb = sum(1 for red, green, blue, value in pixels if value == 0 and (red or green or blue))
    if bbox:
        margins = (bbox[0], bbox[1], CELL_WIDTH - bbox[2], CELL_HEIGHT - bbox[3])
        edge_margin = min(margins)
        coverage = sum(1 for *_rgb, value in pixels if value > 16) / (CELL_WIDTH * CELL_HEIGHT)
    else:
        margins = (-1, -1, -1, -1)
        edge_margin = -1
        coverage = 0.0
    ok = (
        bbox is not None and transparent_corners and edge_margin >= 1 and 0.002 <= coverage <= 0.95
        if used
        else True
    )
    return {
        "sheet": sheet,
        "row": row,
        "column": column,
        "used": used,
        "bbox": list(bbox) if bbox else None,
        "margins": list(margins),
        "edgeMargin": edge_margin,
        "coverage": round(coverage, 5),
        "transparentCorners": transparent_corners,
        "hiddenRgbPixels": hidden_rgb,
        "ok": ok,
    }


def make_contact_sheet(atlases: dict[str, tuple[Image.Image, tuple[str, ...]]], output: Path) -> None:
    scale = 0.5
    cell_width = round(CELL_WIDTH * scale)
    cell_height = round(CELL_HEIGHT * scale)
    label_height = 24
    all_rows = sum(len(names) for _, names in atlases.values())
    width = cell_width * FRAME_COUNT
    canvas = checkerboard(width, all_rows * (cell_height + label_height), 8)
    draw = ImageDraw.Draw(canvas)
    destination_row = 0
    for sheet, (atlas, names) in atlases.items():
        for source_row, name in enumerate(names):
            y = destination_row * (cell_height + label_height)
            draw.rectangle((0, y, width - 1, y + label_height - 1), fill=(24, 29, 38, 255))
            draw.text((6, y + 6), f"{sheet}:{source_row:02d} {name}", fill=(255, 255, 255, 255))
            for column in range(FRAME_COUNT):
                draw.text((column * cell_width + cell_width - 16, y + 6), str(column), fill=(190, 201, 215, 255))
                frame = atlas.crop((column * CELL_WIDTH, source_row * CELL_HEIGHT, (column + 1) * CELL_WIDTH, (source_row + 1) * CELL_HEIGHT))
                frame = frame.resize((cell_width, cell_height), Image.Resampling.LANCZOS)
                canvas.alpha_composite(frame, (column * cell_width, y + label_height))
            destination_row += 1
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output, "PNG")


def make_preview(row_cells: list[Image.Image], output: Path) -> None:
    frames = []
    for cell in row_cells:
        stage = checkerboard(CELL_WIDTH, CELL_HEIGHT)
        stage.alpha_composite(cell.convert("RGBA"))
        frames.append(stage.convert("RGB").resize((CELL_WIDTH * 2, CELL_HEIGHT * 2), Image.Resampling.NEAREST))
    output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=180, loop=0, optimize=False)


def make_direction_sheet(standard: Image.Image, output: Path) -> None:
    display_width = 144
    display_height = 156
    label_height = 34
    columns = 6
    entries = [("neutral", "idle", standard.crop((0, 0, CELL_WIDTH, CELL_HEIGHT)))]
    for index, (degree, expected) in enumerate(DIRECTIONS):
        row = 9 + index // 8
        column = index % 8
        entries.append((degree, expected, standard.crop((column * CELL_WIDTH, row * CELL_HEIGHT, (column + 1) * CELL_WIDTH, (row + 1) * CELL_HEIGHT))))
    rows = (len(entries) + columns - 1) // columns
    canvas = checkerboard(columns * display_width, rows * (display_height + label_height), 9)
    draw = ImageDraw.Draw(canvas)
    for index, (degree, expected, cell) in enumerate(entries):
        x = (index % columns) * display_width
        y = (index // columns) * (display_height + label_height)
        draw.rectangle((x, y, x + display_width - 1, y + label_height - 1), fill=(24, 29, 38, 255))
        draw.text((x + 5, y + 5), f"{degree} {expected}", fill=(255, 255, 255, 255))
        resized = cell.convert("RGBA").resize((display_width, display_height), Image.Resampling.LANCZOS)
        canvas.alpha_composite(resized, (x, y + label_height))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output, "PNG")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate deterministic structural and visual QA artifacts for a Yuanyuan pet pack.")
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--brand", type=Path, default=Path("product-brand.json"))
    parser.add_argument("--pet-root", type=Path)
    parser.add_argument("--icon-root", type=Path)
    parser.add_argument("--license", type=Path)
    parser.add_argument(
        "--official-asset-hashes",
        type=Path,
        default=Path("customization/pet/official-asset-hashes.json"),
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--require-complete-rows",
        action="store_true",
        help="Require all 8 cells in every row; mandatory for newly customized pets.",
    )
    parser.add_argument(
        "--require-custom-assets",
        action="store_true",
        help="Require all pet images, Windows icons and the asset license to differ from the official pack.",
    )
    args = parser.parse_args()

    root = args.project_root.resolve()
    brand_path = (root / args.brand).resolve() if not args.brand.is_absolute() else args.brand.resolve()
    brand = json.loads(brand_path.read_text(encoding="utf-8"))
    pet_root_input = args.pet_root or Path(brand["assets"]["petDirectory"])
    icon_root_input = args.icon_root or Path(brand["assets"]["iconDirectory"])
    license_input = args.license or Path(brand["assets"]["licenseFile"])
    pet_root = (root / pet_root_input).resolve() if not pet_root_input.is_absolute() else pet_root_input.resolve()
    icon_root = (root / icon_root_input).resolve() if not icon_root_input.is_absolute() else icon_root_input.resolve()
    license_path = (root / license_input).resolve() if not license_input.is_absolute() else license_input.resolve()
    official_hashes_path = ((root / args.official_asset_hashes).resolve()
                            if not args.official_asset_hashes.is_absolute()
                            else args.official_asset_hashes.resolve())
    output_dir = (root / args.output_dir).resolve() if not args.output_dir.is_absolute() else args.output_dir.resolve()
    for candidate in (brand_path, pet_root, icon_root, license_path, official_hashes_path, output_dir):
        candidate.relative_to(root)

    manifest_path = pet_root / "pet-manifest.json"
    fallback_path = pet_root / "fallback.png"
    if not fallback_path.is_file() or fallback_path.stat().st_size < 1:
        raise SystemExit(f"missing fallback image: {relative(fallback_path, root)}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("spriteVersionNumber") != 2:
        raise SystemExit("pet manifest must declare spriteVersionNumber 2")
    if (manifest.get("id") != brand["application"]["packageName"]
            or manifest.get("displayName") != brand["pet"]["displayName"]
            or manifest.get("assetLicense") != brand["assets"]["licenseFile"]):
        raise SystemExit("pet manifest identity and license must match product-brand.json")

    output_dir.mkdir(parents=True, exist_ok=False)
    used_cells: dict[str, set[tuple[int, int]]] = {sheet: set() for sheet, _, _ in SHEETS}
    for animation in manifest.get("animations", {}).values():
        sheet = animation.get("sheet", "standard")
        row = animation.get("row")
        if sheet not in used_cells or not isinstance(row, int):
            continue
        for column in animation.get("frames", []):
            if isinstance(column, int):
                used_cells[sheet].add((row, column))
    used_cells["standard"].update((row, column) for row in (9, 10) for column in range(FRAME_COUNT))
    if args.require_complete_rows:
        for sheet, _, row_names in SHEETS:
            used_cells[sheet] = {(row, column) for row in range(len(row_names)) for column in range(FRAME_COUNT)}
    atlases: dict[str, tuple[Image.Image, tuple[str, ...]]] = {}
    atlas_evidence = []
    frame_reports = []
    previews = []
    preview_dir = output_dir / "previews"
    for sheet, filename, row_names in SHEETS:
        source = pet_root / filename
        atlas = Image.open(source).convert("RGBA")
        expected = (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(row_names))
        if atlas.size != expected:
            raise SystemExit(f"{filename} must be {expected[0]}x{expected[1]}, received {atlas.width}x{atlas.height}")
        atlases[sheet] = (atlas, row_names)
        atlas_evidence.append({"sheet": sheet, "path": relative(source, root), "sha256": sha256(source), "bytes": source.stat().st_size, "rows": len(row_names)})
        row_cells = cells(atlas, len(row_names))
        for row_index, (row_name, frames) in enumerate(zip(row_names, row_cells, strict=True)):
            frame_reports.extend(
                inspect_cell(frame, sheet, row_index, column, (row_index, column) in used_cells[sheet])
                for column, frame in enumerate(frames)
            )
            preview = preview_dir / f"{sheet}-{row_index:02d}-{row_name}.gif"
            make_preview(frames, preview)
            previews.append({"sheet": sheet, "row": row_index, "name": row_name, "path": relative(preview, root), "sha256": sha256(preview), "bytes": preview.stat().st_size})

    contact_sheet = output_dir / "contact-sheet.png"
    direction_sheet = output_dir / "look-directions.png"
    make_contact_sheet(atlases, contact_sheet)
    make_direction_sheet(atlases["standard"][0], direction_sheet)
    preview_index = output_dir / "previews-index.json"
    preview_index.write_text(json.dumps({"schemaVersion": 1, "previews": previews}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    semantics_template = output_dir / "direction-semantics.template.json"
    semantics_template.write_text(json.dumps({
        "schemaVersion": 1,
        "reviewedAt": None,
        "reviewedBy": None,
        "visualQa": "pending",
        "contactSheet": relative(contact_sheet, root),
        "directionSheet": relative(direction_sheet, root),
        "directions": [
            {"degree": degree, "expected": expected, "verdict": "pending", "observed": "", "reason": ""}
            for degree, expected in DIRECTIONS
        ],
        "rowReview": [
            {"sheet": sheet, "row": index, "name": name, "verdict": "pending", "reason": ""}
            for sheet, _, names in SHEETS for index, name in enumerate(names)
        ],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    icons = []
    for name in ("32x32.png", "128x128.png", "128x128@2x.png", "icon.ico"):
        icon = icon_root / name
        if not icon.is_file() or icon.stat().st_size < 1:
            raise SystemExit(f"missing Windows icon: {relative(icon, root)}")
        icons.append({"path": relative(icon, root), "sha256": sha256(icon), "bytes": icon.stat().st_size})

    replacement_paths = [pet_root / filename for _, filename, _ in SHEETS]
    replacement_paths.append(fallback_path)
    replacement_paths.extend(icon_root / name for name in ("32x32.png", "128x128.png", "128x128@2x.png", "icon.ico"))
    replacement_paths.append(license_path)
    official_hashes = json.loads(official_hashes_path.read_text(encoding="utf-8"))
    if official_hashes.get("schemaVersion") != 1 or official_hashes.get("profile") != "yuanyuan-official-pet-assets-v2":
        raise SystemExit("official pet asset hash baseline is invalid")
    baseline = official_hashes.get("assets", {})
    unchanged_paths = []
    changed_paths = []
    for candidate in replacement_paths:
        asset_path = relative(candidate, root)
        candidate_hash = sha256(candidate)
        official_hash = baseline.get(asset_path)
        if candidate == license_path and asset_path != "ASSETS_LICENSE.md":
            official_hash = baseline.get("ASSETS_LICENSE.md")
        if not isinstance(official_hash, str):
            raise SystemExit(f"official asset hash baseline does not cover {asset_path}")
        (unchanged_paths if candidate_hash == official_hash else changed_paths).append(asset_path)
    custom_replacement_ok = not unchanged_paths and relative(license_path, root) != "ASSETS_LICENSE.md"

    failures = [frame for frame in frame_reports if not frame["ok"]]
    report = {
        "schemaVersion": 1,
        "profile": "yuanyuan-custom-pet-pack-qa",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "spriteVersionNumber": 2,
        "cell": {"width": CELL_WIDTH, "height": CELL_HEIGHT, "columns": FRAME_COUNT},
        "bindings": {
            "manifest": {"path": relative(manifest_path, root), "sha256": sha256(manifest_path), "bytes": manifest_path.stat().st_size},
            "atlases": atlas_evidence,
            "fallback": {"path": relative(fallback_path, root), "sha256": sha256(fallback_path), "bytes": fallback_path.stat().st_size},
            "icons": icons,
            "assetLicense": {"path": relative(license_path, root), "sha256": sha256(license_path), "bytes": license_path.stat().st_size},
        },
        "artifacts": {
            "contactSheet": {"path": relative(contact_sheet, root), "sha256": sha256(contact_sheet)},
            "directionSheet": {"path": relative(direction_sheet, root), "sha256": sha256(direction_sheet)},
            "previewIndex": {"path": relative(preview_index, root), "sha256": sha256(preview_index), "count": len(previews)},
            "directionSemanticsTemplate": relative(semantics_template, root),
        },
        "structural": {"ok": not failures, "frameCount": len(frame_reports), "failedFrameCount": len(failures), "frames": frame_reports},
        "completeRowsRequired": args.require_complete_rows,
        "customAssetReplacement": {
            "required": args.require_custom_assets,
            "ok": custom_replacement_ok,
            "baselineProfile": official_hashes["profile"],
            "changedPaths": changed_paths,
            "unchangedPaths": unchanged_paths,
        },
        "visualReviewRequired": True,
    }
    report_path = output_dir / "pet-pack-qa-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if failures:
        raise SystemExit(f"pet pack structural QA failed in {len(failures)} cells; see {relative(report_path, root)}")
    if args.require_custom_assets and not custom_replacement_ok:
        raise SystemExit(f"custom pet assets still match the official pack: {', '.join(unchanged_paths)}; see {relative(report_path, root)}")
    print(f"Pet pack QA generated: {relative(report_path, root)}; 39 rows, {len(frame_reports)} cells, 16 directions.")


if __name__ == "__main__":
    main()
