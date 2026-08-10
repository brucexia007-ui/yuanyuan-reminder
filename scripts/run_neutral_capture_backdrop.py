from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from pathlib import Path
import time


user32 = ctypes.windll.user32
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD,
    wintypes.LPCWSTR,
    wintypes.LPCWSTR,
    wintypes.DWORD,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.HWND,
    wintypes.HMENU,
    wintypes.HINSTANCE,
    wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND
user32.SetWindowPos.argtypes = [
    wintypes.HWND,
    wintypes.HWND,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    wintypes.UINT,
]
user32.SetWindowPos.restype = wintypes.BOOL

WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
SS_GRAYRECT = 0x00000005
SW_SHOWNOACTIVATE = 4
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = ctypes.c_void_p(-1)

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79
READY_MARKER = "YUANYUAN_NEUTRAL_CAPTURE_BACKDROP_V1\n"


def ordinary_absolute_output(path: Path) -> bool:
    return path.is_absolute() and path.parent.is_dir() and not path.exists()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ready-file", type=Path, required=True)
    parser.add_argument("--stop-file", type=Path, required=True)
    args = parser.parse_args()

    if not ordinary_absolute_output(args.ready_file):
        raise RuntimeError("ready marker path is unsafe")
    if not ordinary_absolute_output(args.stop_file):
        raise RuntimeError("stop marker path is unsafe")
    if args.ready_file.parent != args.stop_file.parent:
        raise RuntimeError("backdrop markers must share one owned directory")

    left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    if width <= 0 or height <= 0:
        raise RuntimeError("virtual desktop geometry is unavailable")

    backdrop = user32.CreateWindowExW(
        WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        "STATIC",
        "",
        WS_POPUP | WS_VISIBLE | SS_GRAYRECT,
        left,
        top,
        width,
        height,
        None,
        None,
        None,
        None,
    )
    if not backdrop:
        raise RuntimeError("could not create the neutral capture backdrop")
    try:
        user32.ShowWindow(backdrop, SW_SHOWNOACTIVATE)
        if not user32.UpdateWindow(backdrop):
            raise RuntimeError("could not paint the neutral capture backdrop")
        if not user32.SetWindowPos(
            backdrop,
            HWND_TOPMOST,
            left,
            top,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        ):
            raise RuntimeError("could not place the neutral capture backdrop")
        args.ready_file.write_bytes(READY_MARKER.encode("utf-8"))
        while not args.stop_file.exists():
            time.sleep(0.05)
    finally:
        user32.DestroyWindow(backdrop)


if __name__ == "__main__":
    main()
