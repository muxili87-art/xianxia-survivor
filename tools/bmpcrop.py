#!/usr/bin/env python3
"""裁剪 + 整数倍放大一张图，输出 BMP（再用 sips 转 PNG）。

为什么不用 sips 裁剪：sips 的 -c 只支持居中裁剪，没法指定偏移，
而走查要看的永远是画面里的某一个角落（某只怪、某个角标）。
自己解析 BMP 反而更直接：BMP 头很简单，而且机器上没有 PIL。

用法: bmpcrop.py in.png out.png x y w h [zoom]
"""
import struct
import subprocess
import sys
import os


def to_bmp(src, dst):
    subprocess.run(['sips', '-s', 'format', 'bmp', src, '--out', dst],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def read_bmp(p):
    d = open(p, 'rb').read()
    off = struct.unpack_from('<I', d, 10)[0]
    w, h = struct.unpack_from('<ii', d, 18)
    bpp = struct.unpack_from('<H', d, 28)[0]
    topdown = h < 0
    h = abs(h)
    stride = ((w * bpp // 8) + 3) // 4 * 4
    return d, off, w, h, bpp, stride, topdown


def write_bmp(path, w, h, bgr):
    """bgr: bytearray，长度 w*h*3，从上到下、每像素 BGR。"""
    stride = (w * 3 + 3) // 4 * 4
    pad = stride - w * 3
    rows = []
    for y in range(h):
        rows.append(bytes(bgr[y * w * 3:(y + 1) * w * 3]) + b'\x00' * pad)
    body = b''.join(rows)
    hdr = struct.pack('<2sIHHI', b'BM', 14 + 40 + len(body), 0, 0, 14 + 40)
    dib = struct.pack('<IiiHHIIiiII', 40, w, -h, 1, 24, 0, len(body), 2835, 2835, 0, 0)
    open(path, 'wb').write(hdr + dib + body)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    x, y, cw, ch = (int(v) for v in sys.argv[3:7])
    zoom = int(sys.argv[7]) if len(sys.argv) > 7 else 1
    tmp = '/tmp/_bmpcrop_src.bmp'
    to_bmp(src, tmp)
    d, off, w, h, bpp, stride, _ = read_bmp(tmp)
    Bpp = bpp // 8
    ow, oh = cw * zoom, ch * zoom
    out = bytearray(ow * oh * 3)
    for oy in range(oh):
        sy = y + oy // zoom
        for ox in range(ow):
            sx = x + ox // zoom
            if 0 <= sy < h and 0 <= sx < w:
                i = off + sy * stride + sx * Bpp
                o = (oy * ow + ox) * 3
                out[o] = d[i]
                out[o + 1] = d[i + 1]
                out[o + 2] = d[i + 2]
    tmp2 = '/tmp/_bmpcrop_out.bmp'
    write_bmp(tmp2, ow, oh, out)
    subprocess.run(['sips', '-s', 'format', 'png', tmp2, '--out', dst],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.remove(tmp)
    os.remove(tmp2)
    print('cropped %dx%d@(%d,%d) zoom=%d -> %s (%dx%d)' % (cw, ch, x, y, zoom, dst, ow, oh))


if __name__ == '__main__':
    main()
