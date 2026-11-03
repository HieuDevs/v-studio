"""Render the V Studio app icon (speech bubble with a waveform on an indigo → violet
squircle) into packaging/: icon.png (1024), icon-512.png, icon.ico and, on macOS,
icon.icns (needs ``iconutil``).

    python packaging/make_icons.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).parent
SS = 4                      # supersampling factor
S = 1024 * SS
C1, C2 = (99, 102, 241), (168, 85, 247)    # #6366f1 → #a855f7
BAR = (91, 91, 214)                        # #5b5bd6


def px(v: float) -> int:
    return int(round(v * SS))


def render() -> Image.Image:
    # diagonal gradient
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    t = ((x + y) / (2 * S))[..., None]
    grad = (np.array(C1) * (1 - t) + np.array(C2) * t).astype(np.uint8)
    bg = Image.fromarray(grad, "RGB").convert("RGBA")

    # macOS-style squircle: 824 px tile centred on the 1024 canvas
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((px(100), px(100), px(924), px(924)), radius=px(186), fill=255)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(icon)
    white = (255, 255, 255, 255)
    # speech bubble + tail
    d.rounded_rectangle((px(228), px(268), px(796), px(688)), radius=px(128), fill=white)
    d.polygon([(px(318), px(640)), (px(300), px(812)), (px(476), px(680))], fill=white)
    # waveform bars
    heights = [92, 196, 280, 176, 92]
    for i, h in enumerate(heights):
        cx, cy, w = 352 + i * 80, 478, 46
        d.rounded_rectangle((px(cx - w / 2), px(cy - h / 2), px(cx + w / 2), px(cy + h / 2)), radius=px(w / 2), fill=BAR + (255,))
    return icon.resize((1024, 1024), Image.LANCZOS)


def main() -> None:
    img = render()
    img.save(OUT / "icon.png")
    img.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")
    img.save(OUT / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
    if sys.platform == "darwin" and shutil.which("iconutil"):
        with tempfile.TemporaryDirectory() as tmp:
            iconset = Path(tmp) / "icon.iconset"
            iconset.mkdir()
            for n in (16, 32, 128, 256, 512):
                img.resize((n, n), Image.LANCZOS).save(iconset / f"icon_{n}x{n}.png")
                img.resize((n * 2, n * 2), Image.LANCZOS).save(iconset / f"icon_{n}x{n}@2x.png")
            subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
