from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ATLAS = ROOT / "public" / "assets" / "pet" / "spritesheet.webp"
ICON_DIR = ROOT / "src-tauri" / "icons"
FALLBACK = ROOT / "public" / "assets" / "pet" / "fallback.png"


def square_icon(source: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.88)
    sprite = source.copy()
    sprite.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    x = (size - sprite.width) // 2
    y = size - sprite.height - int(size * 0.04)
    canvas.alpha_composite(sprite, (x, y))
    return canvas


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    atlas = Image.open(ATLAS).convert("RGBA")
    neutral = atlas.crop((0, 0, 192, 208))
    neutral.save(FALLBACK)

    icons = {size: square_icon(neutral, size) for size in (32, 64, 128, 256)}
    icons[32].save(ICON_DIR / "32x32.png")
    icons[128].save(ICON_DIR / "128x128.png")
    icons[256].save(ICON_DIR / "128x128@2x.png")
    icons[256].save(
        ICON_DIR / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
