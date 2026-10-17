#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合并封面(cover.pdf) + 正文(body.pdf) → 最终交付 PDF（pypdf，页面统一归一化 A4）。"""
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89
COVER = '/home/z/my-project/scripts/build/cover.pdf'
BODY = '/home/z/my-project/scripts/build/body.pdf'
OUT = '/home/z/my-project/download/趋势自动交易-算法接口文档.pdf'


def normalize(page):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
        page.mediabox.lower_left = (0, 0)
        page.mediabox.upper_right = (A4_W, A4_H)
    return page


def main():
    writer = PdfWriter()
    writer.add_page(normalize(PdfReader(COVER).pages[0]))
    for page in PdfReader(BODY).pages:
        writer.add_page(normalize(page))
    writer.add_metadata({
        '/Title': '趋势自动交易 · 算法（策略）接口文档',
        '/Author': 'hyyLab',
        '/Creator': 'Z.ai',
        '/Subject': 'TrendStrategy 通用算法接口：契约、数据、硬规则、示例与接入四步',
    })
    with open(OUT, 'wb') as f:
        writer.write(f)
    n = len(PdfReader(OUT).pages)
    print('合并完成：%s（共 %d 页）' % (OUT, n))


if __name__ == '__main__':
    main()
