from __future__ import annotations

import argparse
from collections import deque
import json
from pathlib import Path

from PIL import Image, ImageDraw


CELL_WIDTH = 192
CELL_HEIGHT = 208
FRAME_COUNT = 8
ROW_NAMES = (
    "learning-study-sit",
    "learning-study-curious",
    "learning-press-correct",
    "learning-press-wrong",
)
FRAME_DURATIONS_MS = {
    # Frame 3 is the source strip's blink pose. Runtime intentionally skips it:
    # the only study-time blink belongs to the 15-second curious one-shot.
    "learning-study-sit": (720, 520, 420, 240, 560, 680, 760),
    "learning-study-curious": (180, 160, 170, 220, 240, 180, 170, 220),
    "learning-press-correct": (150, 120, 110, 105, 100, 190, 125, 180),
    "learning-press-wrong": (150, 120, 110, 105, 100, 190, 125, 180),
}
PREVIEW_FRAME_INDICES = {
    "learning-study-sit": (0, 1, 2, 4, 5, 6, 7),
}
CHROMA_KEY = (255, 0, 255)

# Equal-width extraction can include a thin slice of a neighboring pose when an
# image-generation frame crosses its nominal slot. These are deliberately tiny,
# frame-local matte trims; the animated paw remains on the opposite side.
SLOT_BLEED_TRIMS: dict[tuple[str, int], tuple[str, int, int, int]] = {
    ("learning-press-correct", 3): ("right", 152, 153, 189),
    ("learning-press-wrong", 3): ("left", 32, 109, 125),
    ("learning-press-wrong", 4): ("left", 34, 103, 123),
    ("learning-press-wrong", 5): ("left", 35, 125, 147),
    ("learning-press-wrong", 6): ("left", 36, 126, 147),
}


def clear_hidden_rgb(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = list(rgba.get_flattened_data())
    rgba.putdata(
        [
            (0, 0, 0, 0) if alpha == 0 else (red, green, blue, alpha)
            for red, green, blue, alpha in pixels
        ]
    )
    return rgba


def keep_largest_component(image: Image.Image) -> Image.Image:
    """Drop any disconnected neighbor-slot fragments after equal-slot extraction."""
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    width, height = rgba.size
    data = alpha.tobytes()
    visited = bytearray(width * height)
    largest: list[int] = []

    for start, alpha_value in enumerate(data):
        if alpha_value <= 16 or visited[start]:
            continue
        queue = deque([start])
        visited[start] = 1
        component: list[int] = []
        while queue:
            current = queue.popleft()
            component.append(current)
            x = current % width
            y = current // width
            for neighbor in (
                current - 1 if x > 0 else -1,
                current + 1 if x + 1 < width else -1,
                current - width if y > 0 else -1,
                current + width if y + 1 < height else -1,
            ):
                if neighbor >= 0 and not visited[neighbor] and data[neighbor] > 16:
                    visited[neighbor] = 1
                    queue.append(neighbor)
        if len(component) > len(largest):
            largest = component

    if not largest:
        return clear_hidden_rgb(rgba)
    keep = bytearray(width * height)
    for pixel_index in largest:
        keep[pixel_index] = 1
    pixels = list(rgba.get_flattened_data())
    rgba.putdata([
        pixel if keep[index] else (0, 0, 0, 0)
        for index, pixel in enumerate(pixels)
    ])
    return clear_hidden_rgb(rgba)


def trim_neighbor_slot_bleed(
    image: Image.Image,
    row_name: str,
    frame_index: int,
) -> Image.Image:
    trim = SLOT_BLEED_TRIMS.get((row_name, frame_index))
    if trim is None:
        return image
    side, boundary, top, bottom = trim
    rgba = image.convert("RGBA")
    pixels = list(rgba.get_flattened_data())
    for y in range(top, bottom):
        for x in range(CELL_WIDTH):
            should_clear = x >= boundary if side == "right" else x < boundary
            if should_clear:
                pixels[y * CELL_WIDTH + x] = (0, 0, 0, 0)
    rgba.putdata(pixels)
    return clear_hidden_rgb(rgba)


def load_row_frames(frames_dir: Path, row_name: str) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for index in range(FRAME_COUNT):
        path = frames_dir / row_name / f"{index:02d}.png"
        if not path.is_file():
            raise SystemExit(f"missing frame: {path}")
        frame = keep_largest_component(Image.open(path))
        frame = trim_neighbor_slot_bleed(frame, row_name, index)
        if frame.size != (CELL_WIDTH, CELL_HEIGHT):
            raise SystemExit(
                f"frame {index} has size {frame.size}, expected "
                f"{CELL_WIDTH}x{CELL_HEIGHT}"
            )
        frames.append(frame)
    return frames


def compose_atlas(rows: dict[str, list[Image.Image]]) -> Image.Image:
    atlas = Image.new(
        "RGBA",
        (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES)),
        (0, 0, 0, 0),
    )
    for row_index, row_name in enumerate(ROW_NAMES):
        for index, frame in enumerate(rows[row_name]):
            atlas.alpha_composite(
                frame,
                (index * CELL_WIDTH, row_index * CELL_HEIGHT),
            )
    return clear_hidden_rgb(atlas)


def chroma_distance(pixel: tuple[int, int, int, int]) -> float:
    red, green, blue, _alpha = pixel
    return ((red - CHROMA_KEY[0]) ** 2 + green**2 + (blue - CHROMA_KEY[2]) ** 2) ** 0.5


def validate(atlas: Image.Image) -> dict[str, object]:
    expected_size = (CELL_WIDTH * FRAME_COUNT, CELL_HEIGHT * len(ROW_NAMES))
    frames: list[dict[str, object]] = []
    ok = atlas.mode == "RGBA" and atlas.size == expected_size

    for row_index, row_name in enumerate(ROW_NAMES):
        for index in range(FRAME_COUNT):
            cell = atlas.crop((
                index * CELL_WIDTH,
                row_index * CELL_HEIGHT,
                (index + 1) * CELL_WIDTH,
                (row_index + 1) * CELL_HEIGHT,
            ))
            alpha = cell.getchannel("A")
            bbox = alpha.getbbox()
            corners = (
                (0, 0),
                (CELL_WIDTH - 1, 0),
                (0, CELL_HEIGHT - 1),
                (CELL_WIDTH - 1, CELL_HEIGHT - 1),
            )
            transparent_corners = all(
                alpha.getpixel(point) == 0 for point in corners
            )
            if bbox:
                margins = {
                    "left": bbox[0],
                    "top": bbox[1],
                    "right": CELL_WIDTH - bbox[2],
                    "bottom": CELL_HEIGHT - bbox[3],
                }
                edge_margin = min(margins.values())
            else:
                margins = {"left": -1, "top": -1, "right": -1, "bottom": -1}
                edge_margin = -1

            pixels = list(cell.get_flattened_data())
            nontransparent = sum(
                1 for *_rgb, alpha_value in pixels if alpha_value > 16
            )
            opaque_chroma = sum(
                1
                for pixel in pixels
                if pixel[3] > 16 and chroma_distance(pixel) <= 38
            )
            hidden_rgb = sum(
                1
                for red, green, blue, alpha_value in pixels
                if alpha_value == 0 and (red or green or blue)
            )
            frame_ok = (
                bbox is not None
                and transparent_corners
                and edge_margin >= 3
                and opaque_chroma == 0
                and hidden_rgb == 0
            )
            ok = ok and frame_ok
            frames.append({
                "row": row_index,
                "state": row_name,
                "index": index,
                "nonEmpty": bbox is not None,
                "bbox": list(bbox) if bbox else None,
                "margins": margins,
                "edgeMargin": edge_margin,
                "transparentCorners": transparent_corners,
                "nontransparentPixels": nontransparent,
                "coverage": round(nontransparent / (CELL_WIDTH * CELL_HEIGHT), 4),
                "opaqueChromaPixels": opaque_chroma,
                "hiddenRgbPixels": hidden_rgb,
                "ok": frame_ok,
            })

    return {
        "ok": ok,
        "width": atlas.width,
        "height": atlas.height,
        "cellWidth": CELL_WIDTH,
        "cellHeight": CELL_HEIGHT,
        "frameCount": FRAME_COUNT,
        "rowCount": len(ROW_NAMES),
        "rows": list(ROW_NAMES),
        "contactFrameIndex": 5,
        "frames": frames,
    }


def checkerboard(width: int, height: int, tile: int = 12) -> Image.Image:
    canvas = Image.new("RGBA", (width, height), (238, 240, 243, 255))
    draw = ImageDraw.Draw(canvas)
    alternate = (217, 221, 226, 255)
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=alternate)
    return canvas


def save_contact_sheet(atlas: Image.Image, output: Path) -> None:
    label_height = 30
    sheet = checkerboard(
        atlas.width,
        atlas.height + label_height * len(ROW_NAMES),
    )
    draw = ImageDraw.Draw(sheet)
    for row_index, row_name in enumerate(ROW_NAMES):
        target_y = row_index * (CELL_HEIGHT + label_height)
        draw.rectangle(
            (0, target_y, atlas.width, target_y + label_height),
            fill=(25, 29, 36, 255),
        )
        draw.text((8, target_y + 8), row_name, fill=(255, 255, 255, 255))
        for index in range(FRAME_COUNT):
            left = index * CELL_WIDTH
            draw.text(
                (left + 132, target_y + 8),
                str(index),
                fill=(255, 255, 255, 255),
            )
            if row_name.startswith("learning-press-") and index == 5:
                draw.rectangle(
                    (left + 1, target_y + 1, left + CELL_WIDTH - 2, target_y + label_height - 2),
                    outline=(70, 210, 126, 255),
                    width=2,
                )
        row = atlas.crop((
            0,
            row_index * CELL_HEIGHT,
            atlas.width,
            (row_index + 1) * CELL_HEIGHT,
        ))
        sheet.alpha_composite(row, (0, target_y + label_height))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(output, "PNG")


def save_preview(row_name: str, frames: list[Image.Image], output: Path) -> None:
    preview_frames: list[Image.Image] = []
    frame_indices = PREVIEW_FRAME_INDICES.get(
        row_name,
        tuple(range(FRAME_COUNT)),
    )
    for frame_index in frame_indices:
        frame = frames[frame_index]
        stage = checkerboard(CELL_WIDTH, CELL_HEIGHT)
        stage.alpha_composite(frame)
        preview_frames.append(
            stage.convert("RGB").resize(
                (CELL_WIDTH * 2, CELL_HEIGHT * 2),
                Image.Resampling.NEAREST,
            )
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    preview_frames[0].save(
        output,
        save_all=True,
        append_images=preview_frames[1:],
        duration=list(FRAME_DURATIONS_MS[row_name]),
        loop=0,
        optimize=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--png-output", type=Path)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--contact-sheet", type=Path, required=True)
    parser.add_argument("--preview", type=Path, required=True)
    parser.add_argument(
        "--validate-existing",
        action="store_true",
        help="Validate and refresh QA from the existing --output atlas.",
    )
    parser.add_argument(
        "--allow-pre-despill-chroma",
        action="store_true",
        help="Allow only residual chroma failures in an intermediate atlas.",
    )
    parser.add_argument(
        "--mirror-frames",
        action="store_true",
        help="Legacy flag rejected because left/right learning rows are independent.",
    )
    args = parser.parse_args()

    if args.validate_existing:
        atlas = clear_hidden_rgb(Image.open(args.output))
        rows = {
            row_name: [
                atlas.crop((
                    index * CELL_WIDTH,
                    row_index * CELL_HEIGHT,
                    (index + 1) * CELL_WIDTH,
                    (row_index + 1) * CELL_HEIGHT,
                ))
                for index in range(FRAME_COUNT)
            ]
            for row_index, row_name in enumerate(ROW_NAMES)
        }
    else:
        rows = {
            row_name: load_row_frames(args.frames_dir, row_name)
            for row_name in ROW_NAMES
        }
        if args.mirror_frames:
            raise SystemExit("four-row learning atlas does not allow mirror derivation")
        atlas = compose_atlas(rows)
    report = validate(atlas)

    if not args.validate_existing:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        atlas.save(args.output, "WEBP", lossless=True, quality=100, method=6)
        if args.png_output:
            args.png_output.parent.mkdir(parents=True, exist_ok=True)
            atlas.save(args.png_output, "PNG")

    args.validation.parent.mkdir(parents=True, exist_ok=True)
    args.validation.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    save_contact_sheet(atlas, args.contact_sheet)
    args.preview.mkdir(parents=True, exist_ok=True)
    for row_name, frames in rows.items():
        save_preview(row_name, frames, args.preview / f"{row_name}.gif")

    if not report["ok"] and args.allow_pre_despill_chroma:
        failures = [frame for frame in report["frames"] if not frame["ok"]]
        only_expected_chroma = bool(failures) and all(
            frame["nonEmpty"]
            and frame["transparentCorners"]
            and frame["edgeMargin"] >= 3
            and frame["opaqueChromaPixels"] > 0
            and frame["hiddenRgbPixels"] == 0
            for frame in failures
        )
        if only_expected_chroma:
            return
    if not report["ok"]:
        raise SystemExit("learning atlas validation failed")


if __name__ == "__main__":
    main()
