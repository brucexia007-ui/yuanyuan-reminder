"""Synthetic test art, created locally; no user photographs or bundled pet artwork."""
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1])
output.mkdir()
manifest = json.loads((root / "public/assets/pet/pet-manifest.json").read_text(encoding="utf-8"))
manifest.update(schemaVersion=1, assetLicense="LICENSE.txt", displayName="Repair test")
for key, name, rows in [("spritesheet", "spritesheet.webp", 11), ("sleepSpritesheet", "sleep-atlas.webp", 3),
                        ("lifeSpritesheet", "life-atlas.webp", 21), ("learningSpritesheet", "learning-atlas.webp", 4),
                        ("sceneSpritesheet", "scene-atlas.webp", 18)]:
    manifest[key] = name
    image = Image.new("RGBA", (1536, rows * 208))
    draw = ImageDraw.Draw(image)
    for row in range(rows):
        for col in range(8):
            draw.rectangle((col * 192 + 55, row * 208 + 45, col * 192 + 130, row * 208 + 185), fill=(30 + col * 20, 40 + row * 6, 150, 255))
    image.save(output / name, lossless=True, exact=True)
fallback = Image.new("RGBA", (192, 208), (7, 8, 9, 0))
ImageDraw.Draw(fallback).rectangle((55, 45, 130, 185), fill=(50, 100, 150, 255))
fallback.save(output / "fallback.png")
for definition in manifest["animations"].values():
    definition.setdefault("staticFrame", definition["frames"][0])
(output / "pet-pack.json").write_text(json.dumps(manifest), encoding="utf-8")
(output / "LICENSE.txt").write_text("Synthetic geometric test fixture. MIT.", encoding="utf-8")
Image.new("RGBA", (1536, 208), (120, 50, 70, 128)).save(output / "replacement.png")
