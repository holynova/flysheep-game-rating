# 生成扩展图标：暗色圆角底 + 金色菱形（暗黑装备风）。纯标准库 PNG 编码。
import struct
import zlib
import os

GOLD = (255, 204, 51)
DARK_GOLD = (122, 92, 12)
BG = (18, 20, 30)


def sd_rounded_box(x, y, size, radius):
    half = size / 2.0
    qx = abs(x - half) - (half - radius)
    qy = abs(y - half) - (half - radius)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return (ax * ax + ay * ay) ** 0.5 + min(max(qx, qy), 0.0) - radius


def color_at(x, y, size):
    radius = size * 0.2
    if sd_rounded_box(x, y, size, radius) > 0:
        return (0, 0, 0, 0)
    half = size / 2.0
    d = abs(x - half) + abs(y - half)
    if d <= size * 0.155:
        return (*DARK_GOLD, 255)
    if d <= size * 0.34:
        return (*GOLD, 255)
    return (*BG, 255)


def make_icon(size, path):
    ss = 4
    rows = []
    for py in range(size):
        row = bytearray()
        row.append(0)  # PNG filter type 0
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px * ss + sx + 0.5) / ss
                    y = (py * ss + sy + 0.5) / ss
                    c = color_at(x, y, size)
                    for i in range(4):
                        acc[i] += c[i]
            n = ss * ss
            row.extend(int(round(v / n)) for v in acc)
        rows.append(bytes(row))

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("created", path, os.path.getsize(path), "bytes")


here = os.path.dirname(os.path.abspath(__file__))
icons = os.path.join(here, "..", "icons")
for size in (16, 48, 128):
    make_icon(size, os.path.join(icons, f"icon{size}.png"))
