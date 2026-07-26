from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import time

from PIL import Image, ImageChops, ImageDraw, ImageGrab, ImageStat


user32 = ctypes.windll.user32


def visible_windows_for_pid(pid: int) -> list[dict[str, object]]:
    windows: list[dict[str, object]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def enum_window(hwnd: int, _lparam: int) -> bool:
        window_pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))
        if window_pid.value != pid or not user32.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        if width <= 0 or height <= 0:
            return True
        title_length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(title_length + 1)
        user32.GetWindowTextW(hwnd, title, title_length + 1)
        windows.append(
            {
                "handle": int(hwnd),
                "title": title.value,
                "rect": [rect.left, rect.top, rect.right, rect.bottom],
                "width": width,
                "height": height,
            }
        )
        return True

    user32.EnumWindows(enum_window, 0)
    return windows


def select_pet_window(windows: list[dict[str, object]]) -> dict[str, object]:
    if not windows:
        raise RuntimeError("no visible windows found for process")
    candidates = [
        window
        for window in windows
        if 100 <= int(window["width"]) <= 600
        and 100 <= int(window["height"]) <= 650
    ]
    if not candidates:
        candidates = windows
    return min(
        candidates,
        key=lambda window: int(window["width"]) * int(window["height"]),
    )


def difference_score(first: Image.Image, second: Image.Image) -> float:
    difference = ImageChops.difference(first.convert("RGB"), second.convert("RGB"))
    return sum(ImageStat.Stat(difference).mean) / 3


def make_contact_sheet(
    frames: list[tuple[int, Image.Image]],
    output: Path,
    columns: int = 8,
) -> None:
    label_height = 22
    frame_width, frame_height = frames[0][1].size
    rows = (len(frames) + columns - 1) // columns
    sheet = Image.new(
        "RGB",
        (columns * frame_width, rows * (frame_height + label_height)),
        (234, 237, 242),
    )
    draw = ImageDraw.Draw(sheet)
    for index, (elapsed_ms, frame) in enumerate(frames):
        column = index % columns
        row = index // columns
        x = column * frame_width
        y = row * (frame_height + label_height)
        sheet.paste(frame.convert("RGB"), (x, y + label_height))
        draw.text((x + 5, y + 5), f"{elapsed_ms / 1000:.1f}s", fill=(20, 24, 30))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, "PNG")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--duration", type=float, default=42.0)
    parser.add_argument("--interval", type=float, default=0.12)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    user32.SetProcessDPIAware()
    windows = visible_windows_for_pid(args.pid)
    selected = select_pet_window(windows)
    rect = tuple(int(value) for value in selected["rect"])
    started = time.monotonic()
    samples: list[tuple[int, Image.Image]] = []
    distinct: list[tuple[int, Image.Image]] = []
    last_distinct: Image.Image | None = None

    while time.monotonic() - started < args.duration:
        captured = ImageGrab.grab(bbox=rect, all_screens=True).convert("RGB")
        elapsed_ms = round((time.monotonic() - started) * 1000)
        samples.append((elapsed_ms, captured))
        if last_distinct is None or difference_score(last_distinct, captured) >= 0.55:
            distinct.append((elapsed_ms, captured.copy()))
            last_distinct = captured
        time.sleep(args.interval)

    if not distinct:
        raise RuntimeError("no frames captured")

    if len(distinct) > 64:
        selected_indices = [
            round(index * (len(distinct) - 1) / 63)
            for index in range(64)
        ]
        contact_frames = [distinct[index] for index in selected_indices]
    else:
        contact_frames = distinct

    args.output_dir.mkdir(parents=True, exist_ok=True)
    make_contact_sheet(contact_frames, args.output_dir / "installed-contact-sheet.png")

    gif_frames = [frame for _, frame in samples[::2]]
    gif_frames[0].save(
        args.output_dir / "installed-animation.gif",
        save_all=True,
        append_images=gif_frames[1:],
        duration=round(args.interval * 2000),
        loop=0,
        optimize=False,
    )
    report = {
        "pid": args.pid,
        "windows": windows,
        "selectedWindow": selected,
        "durationSeconds": args.duration,
        "sampleCount": len(samples),
        "distinctFrameCount": len(distinct),
        "contactFrameCount": len(contact_frames),
    }
    (args.output_dir / "installed-capture.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
