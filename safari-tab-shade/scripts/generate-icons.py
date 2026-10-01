#!/usr/bin/env python3
"""Draw the Tab Shade toolbar icons. No third-party image library required."""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "extension" / "icons"

BLUE = (47, 111, 190, 255)
ORANGE = (196, 69, 54, 255)
CLEAR = (0, 0, 0, 0)


def png(width, height, pixels):
    raw = b"".join(b"\x00" + bytes(pixels[y]) for y in range(height))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def rounded_rect(pixels, width, height, x, y, w, h, radius, color):
    for py in range(y, y + h):
        for px in range(x, x + w):
            if px < 0 or py < 0 or px >= width or py >= height:
                continue
            dx = 0
            dy = 0
            if px < x + radius and py < y + radius:
                dx = x + radius - 1 - px
                dy = y + radius - 1 - py
            elif px >= x + w - radius and py < y + radius:
                dx = px - (x + w - radius)
                dy = y + radius - 1 - py
            elif px < x + radius and py >= y + h - radius:
                dx = x + radius - 1 - px
                dy = py - (y + h - radius)
            elif px >= x + w - radius and py >= y + h - radius:
                dx = px - (x + w - radius)
                dy = py - (y + h - radius)
            if dx * dx + dy * dy > radius * radius:
                continue
            pixels[py][px * 4 : px * 4 + 4] = color


def draw(size):
    pixels = [bytearray(CLEAR * size) for _ in range(size)]
    pad = max(1, size // 16)
    radius = max(2, size // 8)
    gap = max(1, size // 32)
    tab_w = (size - pad * 2 - gap) // 2
    tab_h = size - pad * 2
    rounded_rect(pixels, size, size, pad, pad + size // 10, tab_w, tab_h - size // 10, radius, BLUE)
    rounded_rect(pixels, size, size, pad + tab_w + gap, pad, tab_w, tab_h, radius, ORANGE)
    # A small light mark where the icon sits, and a short bar for the title.
    mark = max(2, size // 10)
    mx = pad + tab_w + gap + max(2, size // 12)
    my = pad + max(3, size // 7)
    rounded_rect(pixels, size, size, mx, my, mark, mark, max(1, mark // 3), (255, 255, 255, 230))
    rounded_rect(
        pixels,
        size,
        size,
        mx + mark + max(1, size // 24),
        my + max(0, mark // 4),
        max(3, tab_w // 3),
        max(2, mark // 2),
        1,
        (255, 255, 255, 230),
    )
    return png(size, size, pixels)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = ROOT / f"icon-{size}.png"
        path.write_bytes(draw(size))
        print(path)


if __name__ == "__main__":
    main()
