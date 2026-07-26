from __future__ import annotations

import argparse
from collections import deque
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


CELL_WIDTH = 192
CELL_HEIGHT = 208
FRAME_COUNT = 8
ROW_NAMES = (
    "grooming",
    "grooming-chest",
    "grooming-flank",
    "stretching",
    "yawning",
    "meowing",
    "belly-up",
    "focus-calm",
    "eating-food",
    "drinking-water",
    "treat-follow",
    "wand-play",
    "pet-nuzzle",
    "ball-bat",
    "wand-reach",
    "wand-swipe",
    "wand-return",
    "ball-pickup",
    "ball-carry",
    "ball-drop",
    "alert-glass-paws",
)


def magenta_to_alpha(source: Image.Image) -> Image.Image:
    rgba = np.asarray(source.convert("RGBA"), dtype=np.uint8).copy()
    rgb = rgba[:, :, :3].astype(np.int16)
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    magenta_gap = np.minimum(red - green, blue - green)
    magenta_brightness = np.minimum(red, blue)

    strength_from_gap = np.clip((magenta_gap - 18) * 255 / 72, 0, 255)
    strength_from_brightness = np.clip(
        (magenta_brightness - 100) * 255 / 80,
        0,
        255,
    )
    background_strength = np.minimum(
        strength_from_gap,
        strength_from_brightness,
    ).astype(np.uint8)
    rgba[:, :, 3] = 255 - background_strength
    strong_magenta = (
        (red > 145)
        & (blue > 145)
        & (green < 145)
        & (magenta_gap > 55)
    )
    rgba[strong_magenta, 3] = 0
    rgba[rgba[:, :, 3] < 18, 3] = 0
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def isolate_largest_component(slot: Image.Image) -> Image.Image:
    rgba = np.asarray(slot.convert("RGBA"), dtype=np.uint8).copy()
    mask = rgba[:, :, 3] > 32
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    largest: list[tuple[int, int]] = []

    for y in range(height):
        for x in range(width):
            if not mask[y, x] or seen[y, x]:
                continue
            queue = deque([(x, y)])
            seen[y, x] = True
            component: list[tuple[int, int]] = []
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for ny in range(max(0, py - 1), min(height, py + 2)):
                    for nx in range(max(0, px - 1), min(width, px + 2)):
                        if mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            queue.append((nx, ny))
            if len(component) > len(largest):
                largest = component

    if not largest:
        raise ValueError("sprite slot has no foreground component")

    keep = np.zeros_like(mask, dtype=bool)
    xs, ys = zip(*largest)
    keep[np.asarray(ys), np.asarray(xs)] = True
    rgba[~keep, 3] = 0
    rgba[~keep, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def clear_transparent_rgb(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgb = rgba[:, :, :3].astype(np.int16)
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    fringe = (
        (rgba[:, :, 3] < 240)
        & (red > 110)
        & (blue > 110)
        & (red > green + 28)
        & (blue > green + 28)
    )
    rgba[fringe, 3] = 0
    rgba[rgba[:, :, 3] < 18, 3] = 0
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def extract_row(source: Image.Image) -> list[Image.Image]:
    source = magenta_to_alpha(source)
    slot_width = source.width / FRAME_COUNT
    crops: list[Image.Image] = []

    for index in range(FRAME_COUNT):
        left = round(index * slot_width)
        right = round((index + 1) * slot_width)
        slot = isolate_largest_component(
            source.crop((left, 0, right, source.height))
        )
        alpha_box = slot.getchannel("A").getbbox()
        if alpha_box is None:
            raise ValueError(f"frame {index} is empty")
        crops.append(slot.crop(alpha_box))

    max_width = max(crop.width for crop in crops)
    max_height = max(crop.height for crop in crops)
    shared_scale = min(
        (CELL_WIDTH - 12) / max_width,
        (CELL_HEIGHT - 10) / max_height,
    )

    frames: list[Image.Image] = []
    for crop in crops:
        width = max(1, round(crop.width * shared_scale))
        height = max(1, round(crop.height * shared_scale))
        resized = clear_transparent_rgb(
            crop.resize((width, height), Image.Resampling.LANCZOS)
        )
        frame = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
        x = (CELL_WIDTH - width) // 2
        y = CELL_HEIGHT - height - 5
        frame.alpha_composite(resized, (x, y))
        frames.append(frame)

    return frames


def validate(atlas: Image.Image) -> dict[str, object]:
    frames: list[dict[str, object]] = []
    ok = atlas.size == (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES))

    for row, name in enumerate(ROW_NAMES):
        for column in range(FRAME_COUNT):
            cell = atlas.crop(
                (
                    column * CELL_WIDTH,
                    row * CELL_HEIGHT,
                    (column + 1) * CELL_WIDTH,
                    (row + 1) * CELL_HEIGHT,
                )
            )
            alpha = cell.getchannel("A")
            bbox = alpha.getbbox()
            non_empty = bbox is not None
            transparent_corners = all(
                alpha.getpixel(point) == 0
                for point in (
                    (0, 0),
                    (CELL_WIDTH - 1, 0),
                    (0, CELL_HEIGHT - 1),
                    (CELL_WIDTH - 1, CELL_HEIGHT - 1),
                )
            )
            edge_margin = (
                min(
                    bbox[0],
                    bbox[1],
                    CELL_WIDTH - bbox[2],
                    CELL_HEIGHT - bbox[3],
                )
                if bbox
                else -1
            )
            frame_ok = non_empty and transparent_corners and edge_margin >= 3
            ok = ok and frame_ok
            frames.append(
                {
                    "row": row,
                    "state": name,
                    "column": column,
                    "nonEmpty": non_empty,
                    "transparentCorners": transparent_corners,
                    "edgeMargin": edge_margin,
                    "bbox": list(bbox) if bbox else None,
                    "ok": frame_ok,
                }
            )

    return {
        "ok": ok,
        "width": atlas.width,
        "height": atlas.height,
        "cellWidth": CELL_WIDTH,
        "cellHeight": CELL_HEIGHT,
        "rows": list(ROW_NAMES),
        "frames": frames,
    }


def save_contact_sheet(atlas: Image.Image, output: Path) -> None:
    label_height = 28
    sheet = Image.new(
        "RGBA",
        (atlas.width, atlas.height + label_height * len(ROW_NAMES)),
        (237, 240, 244, 255),
    )
    draw = ImageDraw.Draw(sheet)
    for row, name in enumerate(ROW_NAMES):
        source_top = row * CELL_HEIGHT
        target_top = row * (CELL_HEIGHT + label_height)
        draw.rectangle(
            (0, target_top, atlas.width, target_top + label_height),
            fill=(222, 226, 232, 255),
        )
        draw.text((10, target_top + 7), name, fill=(25, 29, 36, 255))
        row_image = atlas.crop(
            (0, source_top, atlas.width, source_top + CELL_HEIGHT)
        )
        sheet.alpha_composite(row_image, (0, target_top + label_height))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(output, "PNG")


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ROW_NAMES:
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--png-output", type=Path)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--contact-sheet", type=Path)
    parser.add_argument("--frames-dir", type=Path)
    parser.add_argument("--preview-dir", type=Path)
    args = parser.parse_args()

    row_frames = [
        extract_row(Image.open(getattr(args, name.replace("-", "_"))))
        for name in ROW_NAMES
    ]
    atlas = Image.new(
        "RGBA",
        (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES)),
        (0, 0, 0, 0),
    )
    for row, frames in enumerate(row_frames):
        for column, frame in enumerate(frames):
            atlas.alpha_composite(
                frame,
                (column * CELL_WIDTH, row * CELL_HEIGHT),
            )

    atlas = clear_transparent_rgb(atlas)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.output, "WEBP", lossless=True, quality=100, method=6)
    if args.png_output:
        args.png_output.parent.mkdir(parents=True, exist_ok=True)
        atlas.save(args.png_output, "PNG")

    report = validate(atlas)
    args.validation.parent.mkdir(parents=True, exist_ok=True)
    args.validation.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if args.contact_sheet:
        save_contact_sheet(atlas, args.contact_sheet)

    if args.frames_dir:
        for row, name in enumerate(ROW_NAMES):
            state_dir = args.frames_dir / name
            state_dir.mkdir(parents=True, exist_ok=True)
            for column in range(FRAME_COUNT):
                row_frames[row][column].save(
                    state_dir / f"{column:02d}.png",
                    "PNG",
                )

    if args.preview_dir:
        args.preview_dir.mkdir(parents=True, exist_ok=True)
        for row, name in enumerate(ROW_NAMES):
            gif_frames: list[Image.Image] = []
            for frame in row_frames[row]:
                stage = Image.new("RGBA", frame.size, (237, 240, 244, 255))
                stage.alpha_composite(frame)
                gif_frames.append(
                    stage.convert("RGB").resize(
                        (CELL_WIDTH * 2, CELL_HEIGHT * 2),
                        Image.Resampling.NEAREST,
                    )
                )
            gif_frames[0].save(
                args.preview_dir / f"{name}.gif",
                save_all=True,
                append_images=gif_frames[1:],
                duration=145 if name != "grooming" else 180,
                loop=0,
                optimize=False,
            )

    if not report["ok"]:
        raise SystemExit("life atlas validation failed")


if __name__ == "__main__":
    main()
