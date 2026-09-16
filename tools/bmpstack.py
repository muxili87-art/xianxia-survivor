#!/usr/bin/env python3
"""把两张图裁成同一区域并上下拼成一张对照图，输出 PNG。

为什么需要：作品集里最有力的一张图是「开 / 关」并排 ——
但两张完整截图并排会变得很小，看的人要来回找差异。
裁到**差异所在的那一条带**再上下拼起来，视线不用移动就能对比。

机器上没有 PIL，所以自己读写 BMP（BMP 头很简单，
且这条流水线里 sips 已经能把任意图转成 BMP）。
用法: bmpstack.py a.png b.png out.png x y w h [zoom]
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
    return d, off, w, abs(h), bpp, ((w * bpp // 8) + 3) // 4 * 4


def write_bmp(path, w, h, bgr):
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
    srcA, srcB, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    x, y, cw, ch = (int(v) for v in sys.argv[4:8])
    zoom = int(sys.argv[8]) if len(sys.argv) > 8 else 1
    ow, oh = cw * zoom, ch * zoom

    sep = 4                      # 分隔条像素
    total_h = oh * 2 + sep
    out = bytearray(ow * total_h * 3)

    for idx, src in enumerate((srcA, srcB)):
        tmp = '/tmp/_bmpstack_%d.bmp' % idx
        to_bmp(src, tmp)
        d, off, w, h, bpp, stride = read_bmp(tmp)
        B = bpp // 8
        ybase = idx * (oh + sep)
        for oy in range(oh):
            sy = y + oy // zoom
            orow = (ybase + oy) * ow * 3
            for ox in range(ow):
                sx = x + ox // zoom
                o = orow + ox * 3
                if 0 <= sy < h and 0 <= sx < w:
                    i = off + sy * stride + sx * B
                    out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]
                else:
                    out[o] = 0; out[o + 1] = 0; out[o + 2] = 0
        os.remove(tmp)

    # 分隔条画成中灰，让「这是两张图」一眼可辨
    for yy in range(oh, oh + sep):
        base = yy * ow * 3
        for xx in range(ow):
            o = base + xx * 3
            out[o] = 90; out[o + 1] = 90; out[o + 2] = 90

    tmp2 = '/tmp/_bmpstack_out.bmp'
    write_bmp(tmp2, ow, total_h, out)
    subprocess.run(['sips', '-s', 'format', 'png', tmp2, '--out', dst],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.remove(tmp2)
    print('stacked %dx%d@(%d,%d) zoom=%d -> %s (%dx%d)' % (cw, ch, x, y, zoom, dst, ow, total_h))


if __name__ == '__main__':
    main()
