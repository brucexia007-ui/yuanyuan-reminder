"""Deterministic pixel operations for the offline pet repair CLI; no image generation."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image, ImageChops, ImageDraw

SHEETS = {"spritesheet.webp": 11, "sleep-atlas.webp": 3, "life-atlas.webp": 21,
          "learning-atlas.webp": 4, "scene-atlas.webp": 18, "fallback.png": 1}
CELL = (192, 208)
Image.MAX_IMAGE_PIXELS = 8_000_000


def load(file: Path, size=None) -> Image.Image:
    if file.is_symlink() or not file.is_file():
        raise ValueError("IMAGE_INPUT")
    with Image.open(file) as image:
        expected_format = "PNG" if file.suffix.lower() == ".png" else "WEBP"
        if image.format != expected_format or (size and image.size != size) or image.width * image.height > 8_000_000:
            raise ValueError("IMAGE_FORMAT_OR_SIZE")
        return image.convert("RGBA")


def expected(name):
    return (192 if name == "fallback.png" else 1536, 208 * SHEETS[name])


def canonical(image):
    # Normalize only invisible RGB, retaining every nonzero-alpha value exactly.
    image = image.copy()
    transparent = image.getchannel("A").point(lambda a: 255 if a == 0 else 0)
    image.paste((0, 0, 0, 0), mask=transparent)
    return image


def save_exact(image, file):
    kwargs = {"lossless": True, "exact": True, "method": 4} if file.suffix == ".webp" else {}
    image.save(file, **kwargs)
    if load(file, image.size).tobytes() != image.tobytes():
        raise ValueError("ENCODING_CHANGED_PIXELS")


def row_box(row, width=1536):
    return (0, row * 208, width, (row + 1) * 208)


def inspect(source, output):
    result = {"images": {}, "errors": []}
    for name, rows in SHEETS.items():
        if not (source / name).exists():
            continue
        try:
            image = load(source / name, expected(name))
            row_data = []
            for row in range(rows):
                boxes = []
                for column in range(1 if name == "fallback.png" else 8):
                    frame = image.crop((column * 192, row * 208, (column + 1) * 192, (row + 1) * 208))
                    boxes.append(frame.getchannel("A").getbbox())
                row_data.append({"row": row, "bounds": boxes, "emptyColumns": [i for i, box in enumerate(boxes) if box is None]})
            result["images"][name] = {"rows": row_data, "size": list(image.size)}
            thumb = Image.new("RGB", (image.width // 2 + 40, image.height // 2), (238, 240, 244))
            small = image.resize((image.width // 2, image.height // 2), Image.Resampling.LANCZOS)
            thumb.paste(small, (40, 0), small)
            draw = ImageDraw.Draw(thumb)
            for row in range(rows):
                draw.text((3, row * 104 + 45), str(row), fill=(20, 20, 20))
            thumb.save(output / (name + ".contact.png"))
        except (ValueError, OSError, Image.DecompressionBombError):
            result["errors"].append({"file": name, "code": "IMAGE_DECODE_OR_GEOMETRY"})
    return result


def apply(request):
    source, destination = Path(request["source"]), Path(request["destination"])
    images = {}
    for operation in request["operations"]:
        name = operation["file"]
        if name not in SHEETS:
            raise ValueError("IMAGE_NOT_ALLOWED")
        image = images.get(name)
        if image is None:
            image = load(source / name, expected(name))
        kind = operation["type"]
        if kind == "clear-hidden-rgb":
            image = canonical(image)
        elif kind in ("translate-row", "replace-row"):
            row = operation["row"]
            if type(row) is not int or not 0 <= row < SHEETS[name] or name == "fallback.png":
                raise ValueError("ROW_OUT_OF_RANGE")
            if kind == "replace-row":
                replacement = Path(operation["input"])
                if hashlib.sha256(replacement.read_bytes()).hexdigest() != operation["sha256"]:
                    raise ValueError("ROW_INPUT_DRIFT")
                strip = load(replacement, (1536, 208))
                if any(strip.crop((col * 192, 0, (col + 1) * 192, 208)).getchannel("A").getbbox() is None for col in range(8)):
                    raise ValueError("ROW_HAS_EMPTY_CELL")
            else:
                dx, dy = operation["dx"], operation["dy"]
                if type(dx) is not int or type(dy) is not int or abs(dx) >= 192 or abs(dy) >= 208:
                    raise ValueError("INVALID_TRANSLATION")
                strip = Image.new("RGBA", (1536, 208))
                for col in range(8):
                    cell = image.crop((col * 192, row * 208, (col + 1) * 192, (row + 1) * 208))
                    bounds = cell.getchannel("A").getbbox()
                    if bounds and (bounds[0] + dx < 0 or bounds[1] + dy < 0 or bounds[2] + dx > 192 or bounds[3] + dy > 208):
                        raise ValueError("TRANSLATION_WOULD_CROP")
                    shifted = Image.new("RGBA", CELL)
                    shifted.paste(cell, (dx, dy))
                    strip.paste(shifted, (col * 192, 0))
            image.paste(strip, (0, row * 208))
        else:
            raise ValueError("UNKNOWN_PIXEL_OPERATION")
        images[name] = image
    for name, image in images.items():
        save_exact(image, destination / name)
    return {"written": sorted(images)}


def compare(before, after):
    result = {"changedRows": {}, "errors": []}
    for name, rows in SHEETS.items():
        if not (before / name).exists() and not (after / name).exists():
            continue
        try:
            left = canonical(load(before / name, expected(name)))
            right = canonical(load(after / name, expected(name)))
            result["changedRows"][name] = [r for r in range(rows) if left.crop(row_box(r, left.width)).tobytes() != right.crop(row_box(r, right.width)).tobytes()]
        except (ValueError, OSError, Image.DecompressionBombError):
            result["errors"].append({"file": name, "code": "UNCOMPARABLE_IMAGE"})
    return result


if __name__ == "__main__":
    try:
        command, *args = sys.argv[1:]
        if command == "inspect":
            result = inspect(Path(args[0]), Path(args[1]))
        elif command == "apply":
            result = apply(json.loads(Path(args[0]).read_text(encoding="utf-8")))
        elif command == "compare":
            result = compare(Path(args[0]), Path(args[1]))
        else:
            raise ValueError("UNKNOWN_COMMAND")
        print(json.dumps(result, ensure_ascii=True))
    except Exception as error:
        # Do not emit private source paths from Pillow or filesystem exceptions.
        print(json.dumps({"error": str(error) if type(error) is ValueError else "PIXEL_OPERATION_FAILED"}), file=sys.stderr)
        sys.exit(2)
