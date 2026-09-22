from __future__ import annotations

import argparse
from collections import deque
from io import BytesIO
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


CELL_WIDTH = 192
CELL_HEIGHT = 208
FRAME_COUNT = 8
ROW_NAMES = (
    "spa-enter",
    "spa-loop",
    "spa-exit",
    "meal-alert",
    "meal-wait",
    "hydration-alert",
    "hydration-wait",
    "work-focus-loop",
    "work-fatigue-enter",
    "work-fatigue-loop",
    "work-recover",
    "warmup-alert",
    "warmup-loop",
    "study-focus-loop",
    "study-curious",
    "night-enter",
    "night-loop",
    "night-exit",
)
LOOP_ROWS = {
    "spa-loop",
    "meal-wait",
    "hydration-wait",
    "work-focus-loop",
    "work-fatigue-loop",
    "warmup-loop",
    "study-focus-loop",
    "night-loop",
}


def clear_hidden_rgb(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgba[rgba[:, :, 3] < 12, 3] = 0
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def remove_checkerboard(source: Image.Image) -> Image.Image:
    rgb = np.asarray(source.convert("RGB"), dtype=np.uint8)
    high = rgb.max(axis=2).astype(np.int16)
    low = rgb.min(axis=2).astype(np.int16)
    candidate = (high - low <= 16) & (low >= 214)
    height, width = candidate.shape
    seen = np.zeros((height, width), dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        if candidate[0, x]:
            seen[0, x] = True
            queue.append((x, 0))
        if candidate[height - 1, x] and not seen[height - 1, x]:
            seen[height - 1, x] = True
            queue.append((x, height - 1))
    for y in range(height):
        if candidate[y, 0] and not seen[y, 0]:
            seen[y, 0] = True
            queue.append((0, y))
        if candidate[y, width - 1] and not seen[y, width - 1]:
            seen[y, width - 1] = True
            queue.append((width - 1, y))
    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if (
                0 <= nx < width
                and 0 <= ny < height
                and candidate[ny, nx]
                and not seen[ny, nx]
            ):
                seen[ny, nx] = True
                queue.append((nx, ny))
    rgba = np.empty((height, width, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb
    rgba[:, :, 3] = np.where(seen, 0, 255).astype(np.uint8)
    rgba[seen, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def foreground_source(source: Image.Image) -> Image.Image:
    rgba = source.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    corners = (
        alpha[0, 0],
        alpha[0, -1],
        alpha[-1, 0],
        alpha[-1, -1],
    )
    if min(corners) == 0 and np.count_nonzero(alpha == 0) > alpha.size // 12:
        return clear_hidden_rgb(rgba)
    return remove_checkerboard(source)


def complete_pose_crops(image: Image.Image) -> tuple[list[Image.Image], dict[str, object]]:
    """Recover complete separated poses before fitting them into atlas cells.

    Generated strips do not promise equal-width slots. Slicing first can cut a
    perfectly complete animal, then hide that cut behind valid output margins.
    Ambiguous/touching poses and source-edge clipping must fail before fitting.
    """
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    mask = rgba[:, :, 3] > 16
    height, width = mask.shape
    labels = np.zeros(mask.shape, dtype=np.int32)
    components: list[dict[str, object]] = []
    for y, x in zip(*np.nonzero(mask)):
        if labels[y, x]:
            continue
        x, y = int(x), int(y)
        label = len(components) + 1
        queue = deque([(x, y)])
        labels[y, x] = label
        area = 0
        left = right = x
        top = bottom = y
        while queue:
            px, py = queue.popleft()
            area += 1
            left, right = min(left, px), max(right, px)
            top, bottom = min(top, py), max(bottom, py)
            for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                if (0 <= nx < width and 0 <= ny < height
                        and mask[ny, nx] and not labels[ny, nx]):
                    labels[ny, nx] = label
                    queue.append((nx, ny))
        components.append({"label": label, "pixels": area,
                           "bbox": [left, top, right + 1, bottom + 1]})
    # Ignore isolated antialias specks, not meaningful detached body parts.
    cutoff = max(64, max((part["pixels"] for part in components), default=0) // 200)
    poses = [part for part in components if part["pixels"] >= cutoff]
    if len(poses) != FRAME_COUNT:
        raise ValueError(f"expected {FRAME_COUNT} separated complete poses, found {len(poses)}; "
                         "repair the source row instead of blindly slicing it")
    poses.sort(key=lambda part: part["bbox"][0] + part["bbox"][2])
    crops: list[Image.Image] = []
    for index, part in enumerate(poses):
        left, top, right, bottom = part["bbox"]
        if left == 0 or top == 0 or right == width or bottom == height:
            raise ValueError(f"pose {index} touches a source canvas edge; possible clipping")
        crop = rgba[top:bottom, left:right].copy()
        keep = labels[top:bottom, left:right] == part["label"]
        crop[~keep] = 0
        legacy_left = round(index * width / FRAME_COUNT)
        legacy_right = round((index + 1) * width / FRAME_COUNT)
        source_x = np.arange(left, right)
        part["outsideLegacySlotPixels"] = int(np.count_nonzero(
            keep[:, (source_x < legacy_left) | (source_x >= legacy_right)]))
        crops.append(clear_hidden_rgb(Image.fromarray(crop)))
    return crops, {"method": "complete-connected-poses-v1", "sourceSize": [width, height],
                   "foregroundAlphaThreshold": 16, "componentPixelCutoff": cutoff,
                   "discardedNoisePixels": sum(part["pixels"] for part in components
                                               if part["pixels"] < cutoff),
                   "poses": poses}


def extract_row(path: Path, report: dict[str, object] | None = None, *,
                reference_frame: Image.Image | None = None,
                reference_column: int = 0) -> list[Image.Image]:
    if type(reference_column) is not int or not 0 <= reference_column < FRAME_COUNT:
        raise ValueError("reference column must be an integer from 0 to 7")
    if reference_frame is None and reference_column != 0:
        raise ValueError("reference column requires a reference frame")
    with Image.open(path) as raw:
        original_mode = raw.mode
        native_alpha = np.asarray(raw.convert("RGBA"))[:, :, 3]
        transparent_pixels = int(np.count_nonzero(native_alpha == 0))
        source = foreground_source(raw)
    try:
        crops, extraction = complete_pose_crops(source)
    except ValueError as error:
        raise ValueError(f"{path.name}: {error}") from error
    shared_scale = min(
        (CELL_WIDTH - 10) / max(crop.width for crop in crops),
        (CELL_HEIGHT - 8) / max(crop.height for crop in crops),
    )
    center_x, baseline = CELL_WIDTH / 2, CELL_HEIGHT - 4
    registration = None
    if reference_frame is not None:
        if reference_frame.mode != "RGBA" or reference_frame.size != (CELL_WIDTH, CELL_HEIGHT):
            raise ValueError("reference frame must be an RGBA 192x208 cell")
        box = reference_frame.getchannel("A").getbbox()
        if box is None or min(box[0], box[1], CELL_WIDTH - box[2], CELL_HEIGHT - box[3]) < 3:
            raise ValueError("reference frame must be nonempty with at least 3px clear margin")
        # Match a semantically equivalent incoming/outgoing endpoint, not the
        # maximum height of a low-pose loop. Every source crop is resized once
        # at this same scale; an incompatible wide/tall pose fails, never clips
        # or silently reduces the approved reference transform.
        shared_scale = (box[3] - box[1]) / crops[reference_column].height
        center_x, baseline = (box[0] + box[2]) / 2, box[3]
        registration = {"method": "endpoint-height-center-baseline-v1",
                        "sourceColumn": reference_column, "referenceBbox": list(box)}
    frames: list[Image.Image] = []
    for column, crop in enumerate(crops):
        width = max(1, round(crop.width * shared_scale))
        height = max(1, round(crop.height * shared_scale))
        left, top = int(center_x - width / 2), baseline - height
        if min(left, top, CELL_WIDTH - left - width, CELL_HEIGHT - top - height) < 3:
            raise ValueError(f"registration cannot fit complete pose {column}; repair source row")
        resized = clear_hidden_rgb(
            crop.resize((width, height), Image.Resampling.LANCZOS)
        )
        frame = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
        frame.alpha_composite(resized, (left, top))
        frames.append(clear_hidden_rgb(frame))
    if report is not None:
        report.update(extraction, sharedScale=shared_scale, originalMode=original_mode,
                      nativeTransparentPixels=transparent_pixels)
        if registration is not None:
            report["registration"] = registration
    return frames


def load_row_registrations(path: Path | None, selected_rows: tuple[str, ...] | list[str]
                           ) -> dict[str, dict[str, object]]:
    """Read optional developer-owned whole-row endpoint registration inputs."""
    if path is None:
        return {}
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or set(config) - set(selected_rows):
        raise ValueError("registration must map only selected row names to references")
    for name, item in config.items():
        if (not isinstance(item, dict) or set(item) != {"referenceFrame", "sourceColumn"}
                or not isinstance(item["referenceFrame"], str) or not item["referenceFrame"].strip()
                or type(item["sourceColumn"]) is not int or not 0 <= item["sourceColumn"] < FRAME_COUNT):
            raise ValueError(f"invalid registration for {name}")
        item["referenceFrame"] = path.parent / item["referenceFrame"]
    return config


def compose(rows: dict[str, list[Image.Image]], base: Image.Image | None = None) -> Image.Image:
    if set(rows) - set(ROW_NAMES):
        raise ValueError("unknown scene row")
    expected_size = (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES))
    if base is not None and (base.size != expected_size or base.mode != "RGBA"):
        raise ValueError("base atlas must be an RGBA 1536x3744 image")
    for name, frames in rows.items():
        if len(frames) != FRAME_COUNT:
            raise ValueError(f"{name} must contain exactly {FRAME_COUNT} complete frames")
        if any(frame.size != (CELL_WIDTH, CELL_HEIGHT) or frame.mode != "RGBA" for frame in frames):
            raise ValueError(f"{name} frames must be RGBA 192x208 cells")
    atlas = base.copy() if base is not None else Image.new(
        "RGBA",
        (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES)),
        (0, 0, 0, 0),
    )
    for row_index, name in enumerate(ROW_NAMES):
        if name not in rows:
            if base is None:
                raise ValueError(f"missing row {name}")
            continue
        for column, frame in enumerate(rows[name]):
            # Replace the whole cell, including transparency; old pixels may
            # not survive when a repaired silhouette becomes narrower.
            atlas.paste(frame, (column * CELL_WIDTH, row_index * CELL_HEIGHT))
    # WebP encoders may carry arbitrary RGB under zero alpha. Normalize only
    # those invisible pixels; every existing nonzero-alpha pixel is preserved.
    rgba = np.asarray(atlas.convert("RGBA"), dtype=np.uint8).copy()
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba)


def validate(atlas: Image.Image) -> dict[str, object]:
    expected_size = (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES))
    frames: list[dict[str, object]] = []
    ok = atlas.mode == "RGBA" and atlas.size == expected_size
    for row_index, name in enumerate(ROW_NAMES):
        for column in range(FRAME_COUNT):
            cell = atlas.crop((
                column * CELL_WIDTH,
                row_index * CELL_HEIGHT,
                (column + 1) * CELL_WIDTH,
                (row_index + 1) * CELL_HEIGHT,
            ))
            alpha = cell.getchannel("A")
            box = alpha.getbbox()
            corners_clear = all(
                alpha.getpixel(point) == 0
                for point in ((0, 0), (191, 0), (0, 207), (191, 207))
            )
            rgba = np.asarray(cell)
            hidden_rgb = int(np.count_nonzero(
                (rgba[:, :, 3] == 0) & np.any(rgba[:, :, :3] != 0, axis=2)))
            margins = None
            edge_margin = -1
            if box:
                margins = [box[0], box[1], CELL_WIDTH - box[2], CELL_HEIGHT - box[3]]
                edge_margin = min(margins)
            frame_ok = box is not None and corners_clear and edge_margin >= 3 and hidden_rgb == 0
            ok = ok and frame_ok
            frames.append({
                "row": row_index,
                "state": name,
                "column": column,
                "bbox": list(box) if box else None,
                "margins": margins,
                "edgeMargin": edge_margin,
                "transparentCorners": corners_clear,
                "hiddenRgbPixels": hidden_rgb,
                "ok": frame_ok,
            })
    return {
        "ok": ok,
        "width": atlas.width,
        "height": atlas.height,
        "cellWidth": CELL_WIDTH,
        "cellHeight": CELL_HEIGHT,
        "columns": FRAME_COUNT,
        "rowCount": len(ROW_NAMES),
        "rows": list(ROW_NAMES),
        "frames": frames,
    }


def checkerboard(width: int, height: int, tile: int = 12) -> Image.Image:
    canvas = Image.new("RGBA", (width, height), (244, 246, 248, 255))
    draw = ImageDraw.Draw(canvas)
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=(224, 228, 232, 255))
    return canvas


def encode_verified_atlas(atlas: Image.Image) -> tuple[bytes, dict[str, object]]:
    report = validate(atlas)
    if not report["ok"]:
        raise ValueError("scene atlas validation failed before encoding")
    encoded = BytesIO()
    atlas.save(encoded, "WEBP", lossless=True, quality=100, method=6, exact=True)
    payload = encoded.getvalue()
    decoded = Image.open(BytesIO(payload)).convert("RGBA")
    decoded_report = validate(decoded)
    if not decoded_report["ok"] or not np.array_equal(np.asarray(atlas), np.asarray(decoded)):
        raise ValueError("encoded scene atlas failed decoded pixel/alpha validation")
    report["encodedWebpPixelExact"] = True
    report["encodedWebpValidated"] = True
    return payload, report


def save_qa(atlas: Image.Image, contact_path: Path, preview_dir: Path,
            row_names: tuple[str, ...] = ROW_NAMES) -> None:
    label_height = 24
    contact = checkerboard(atlas.width, len(row_names) * (CELL_HEIGHT + label_height))
    draw = ImageDraw.Draw(contact)
    for position, name in enumerate(row_names):
        row_index = ROW_NAMES.index(name)
        top = position * (CELL_HEIGHT + label_height)
        draw.rectangle((0, top, atlas.width, top + label_height), fill=(31, 38, 46, 255))
        draw.text((7, top + 6), f"{row_index:02d} {name}", fill="white")
        row = atlas.crop((0, row_index * CELL_HEIGHT, atlas.width, (row_index + 1) * CELL_HEIGHT))
        contact.alpha_composite(row, (0, top + label_height))
    contact_path.parent.mkdir(parents=True, exist_ok=True)
    contact.convert("RGB").save(contact_path, "PNG")
    preview_dir.mkdir(parents=True, exist_ok=True)
    for name in row_names:
        row_index = ROW_NAMES.index(name)
        frames: list[Image.Image] = []
        for column in range(FRAME_COUNT):
            cell = atlas.crop((column * CELL_WIDTH, row_index * CELL_HEIGHT, (column + 1) * CELL_WIDTH, (row_index + 1) * CELL_HEIGHT))
            stage = checkerboard(CELL_WIDTH, CELL_HEIGHT)
            stage.alpha_composite(cell)
            frames.append(stage.convert("RGB").resize((384, 416), Image.Resampling.NEAREST))
        frames[0].save(preview_dir / f"{name}.gif", save_all=True, append_images=frames[1:], duration=280, loop=0, optimize=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--png-output", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--contact-sheet", type=Path, required=True)
    parser.add_argument("--preview-dir", type=Path, required=True)
    parser.add_argument("--base-atlas", type=Path,
                        help="preserve existing rows when repairing a subset")
    parser.add_argument("--rows", nargs="+", choices=ROW_NAMES,
                        help="complete row names to replace; requires --base-atlas")
    parser.add_argument("--row-registration", type=Path,
                        help="JSON row -> {referenceFrame, sourceColumn}; paths relative to JSON")
    args = parser.parse_args()
    if args.rows and not args.base_atlas:
        parser.error("--rows requires --base-atlas")
    if args.rows and len(set(args.rows)) != len(args.rows):
        parser.error("--rows must not contain duplicates")
    base = Image.open(args.base_atlas).convert("RGBA") if args.base_atlas else None
    if base is not None and base.size != (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES)):
        parser.error("base atlas has the wrong dimensions")
    source_reports: dict[str, dict[str, object]] = {}
    rows = {}
    registrations = load_row_registrations(args.row_registration, args.rows or ROW_NAMES)
    for name in args.rows or ROW_NAMES:
        source_reports[name] = {}
        registration = registrations.get(name)
        if registration is None:
            rows[name] = extract_row(args.source_dir / f"{name}.png", source_reports[name])
        else:
            with Image.open(registration["referenceFrame"]) as reference:
                rows[name] = extract_row(args.source_dir / f"{name}.png", source_reports[name],
                                        reference_frame=reference,
                                        reference_column=registration["sourceColumn"])
            source_reports[name]["registration"]["referenceFile"] = str(registration["referenceFrame"])
    atlas = compose(rows, base)
    encoded, report = encode_verified_atlas(atlas)
    report["sourceRows"] = source_reports
    report["preservedRows"] = [name for name in ROW_NAMES if name not in rows]
    if not report["ok"]:
        raise SystemExit("scene atlas validation failed; outputs were not written")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(encoded)
    args.png_output.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.png_output, "PNG")
    args.validation.parent.mkdir(parents=True, exist_ok=True)
    args.validation.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    save_qa(atlas, args.contact_sheet, args.preview_dir)
    if not report["ok"]:
        raise SystemExit("scene atlas validation failed")


if __name__ == "__main__":
    main()
