#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""趋势自动交易 · 算法接口文档 — ReportLab 正文生成（docs/strategy-interface.md → body.pdf）

管线（briefs/report.md Step 5 BUILD）：
  MD 解析 → story（TOC Gate: TocDocTemplate + multiBuild）→ body.pdf
  封面另行由 cover.html 经 html2poster.js 渲染后 pypdf 合并（merge_cover.py）。

章节编号映射（Step 3.5，封面/目录不编号，正文沿用文档自身 §0-§8：
§0 为前言性质速览，正文主章从 §1 起，文档内部交叉引用（§4.1/§6.4…）与编号自洽）：
  | Outline | 类型    | 章号 | 标题                 |
  | 1       | cover   | —    | 封面                 |
  | 2       | toc     | —    | 目录                 |
  | 3       | content | §0   | 一页速览（前言）     |
  | 4-11    | content | §1-8 | 体系/接口/契约/硬规则/示例/上线/管理/红线 |
"""
import os
import re
import sys
import hashlib

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily, stringWidth
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    CondPageBreak, KeepTogether, HRFlowable,
)
from reportlab.platypus.tableofcontents import TableOfContents

# ---------- 字体注册（briefs/report.md 白名单字体，路径已实测存在） ----------
FONT_DIR = '/usr/share/fonts'
pdfmetrics.registerFont(TTFont('NotoSerifSC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSC-Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('SarasaMonoSC', f'{FONT_DIR}/truetype/chinese/SarasaMonoSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif', f'{FONT_DIR}/truetype/freefont/FreeSerif.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Bold', f'{FONT_DIR}/truetype/freefont/FreeSerifBold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Italic', f'{FONT_DIR}/truetype/freefont/FreeSerifItalic.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuSans', f'{FONT_DIR}/truetype/dejavu/DejaVuSansMono.ttf'))
registerFontFamily('NotoSerifSC', normal='NotoSerifSC', bold='NotoSerifSC-Bold')
registerFontFamily('FreeSerif', normal='FreeSerif', bold='FreeSerif-Bold',
                   italic='FreeSerif-Italic', boldItalic='FreeSerif-Bold')
registerFontFamily('SarasaMonoSC', normal='SarasaMonoSC', bold='SarasaMonoSC')
registerFontFamily('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans')

# 混排字符级回退（缺字自动 <font> 包裹——防 Helvetica 乱码的第一要务）
sys.path.insert(0, '/home/z/my-project/skills/pdf/scripts')
from pdf import install_font_fallback  # noqa: E402
install_font_fallback()

# ---------- 级联色板（design_engine.py palette-cascade --intent cold --mode minimal，CSS 输出为唯一真源） ----------
PAGE_BG      = colors.HexColor('#f5f5f6')
SECTION_BG   = colors.HexColor('#e9ebeb')
CARD_BG      = colors.HexColor('#ecedee')
TABLE_STRIPE = colors.HexColor('#f1f3f3')
HEADER_FILL  = colors.HexColor('#465861')
COVER_BLOCK  = colors.HexColor('#415d6b')
BORDER       = colors.HexColor('#aebec5')
ICON         = colors.HexColor('#4d7f98')
ACCENT       = colors.HexColor('#3090c0')
ACCENT_2     = colors.HexColor('#b13b4f')
TEXT_PRIMARY = colors.HexColor('#1d1f20')
TEXT_MUTED   = colors.HexColor('#7a8084')

# ---------- 版面几何（左右对称铁律） ----------
PAGE_W, PAGE_H = A4
MARGIN = 54.0                       # 左 == 右
TOP_MARGIN, BOTTOM_MARGIN = 66.0, 58.0
AVAIL_W = PAGE_W - 2 * MARGIN       # ≈ 487pt
AVAIL_H = PAGE_H - TOP_MARGIN - BOTTOM_MARGIN
MAX_KEEP_HEIGHT = PAGE_H * 0.4

MD_PATH = '/home/z/my-project/docs/strategy-interface.md'
OUT_PDF = '/home/z/my-project/scripts/build/body.pdf'
DOC_TITLE = '趋势自动交易 · 算法（策略）接口文档'

# ---------- 样式 ----------
S = {}
S['body'] = ParagraphStyle('Body', fontName='NotoSerifSC', fontSize=10.3, leading=17,
                           alignment=TA_LEFT, wordWrap='CJK', textColor=TEXT_PRIMARY,
                           spaceBefore=0, spaceAfter=7)
S['bullet'] = ParagraphStyle('Bullet', parent=S['body'], leftIndent=14, bulletIndent=2,
                             firstLineIndent=0, spaceAfter=4.5, bulletFontName='NotoSerifSC')
S['numbered'] = ParagraphStyle('Numbered', parent=S['body'], leftIndent=17, firstLineIndent=-17,
                               spaceAfter=4.5, bulletFontName='NotoSerifSC')
S['h1'] = ParagraphStyle('H1', fontName='NotoSerifSC-Bold', fontSize=17.5, leading=25,
                         textColor=TEXT_PRIMARY, spaceBefore=0, spaceAfter=3, wordWrap='CJK')
S['h2'] = ParagraphStyle('H2', fontName='NotoSerifSC-Bold', fontSize=12.8, leading=18.5,
                         textColor=HEADER_FILL, spaceBefore=13, spaceAfter=5, wordWrap='CJK')
S['quote'] = ParagraphStyle('Quote', parent=S['body'], fontSize=9.8, leading=15.5,
                            textColor=TEXT_MUTED, spaceAfter=0)
S['code'] = ParagraphStyle('Code', fontName='SarasaMonoSC', fontSize=7.9, leading=11.0,
                           alignment=TA_LEFT, textColor=TEXT_PRIMARY)
S['th'] = ParagraphStyle('TH', fontName='NotoSerifSC', fontSize=9.4, leading=13,
                         alignment=TA_CENTER, textColor=colors.white, wordWrap='CJK')
S['td'] = ParagraphStyle('TD', fontName='NotoSerifSC', fontSize=9.0, leading=12.8,
                         alignment=TA_LEFT, textColor=TEXT_PRIMARY, wordWrap='CJK')
S['toc_title'] = ParagraphStyle('TocTitle', fontName='NotoSerifSC-Bold', fontSize=17.5,
                                leading=25, textColor=TEXT_PRIMARY, spaceAfter=14)
S['toc0'] = ParagraphStyle('TOC0', fontName='NotoSerifSC-Bold', fontSize=11.2, leading=19,
                           leftIndent=0, textColor=TEXT_PRIMARY, bulletFontName='NotoSerifSC')
S['toc1'] = ParagraphStyle('TOC1', fontName='NotoSerifSC', fontSize=9.8, leading=15.5,
                           leftIndent=18, textColor=TEXT_MUTED, bulletFontName='NotoSerifSC')

MONO_TAG = '<font name="SarasaMonoSC" size="9.0">%s</font>'


def esc(s: str) -> str:
    return s.replace('&', '&').replace('<', '<').replace('>', '>')


def inline(s: str) -> str:
    """行内 MD → ReportLab 标记：先转义，再套 **加粗** 与 `等宽`。"""
    s = esc(s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'`([^`]+)`', lambda m: MONO_TAG % m.group(1), s)
    return s


def code_line_para(raw: str):
    """代码行 → Paragraph（前导空格转 nbsp；超宽行按像素测宽硬折行）。"""
    line = raw.rstrip('\n')
    expanded = esc(line.replace('\t', '    '))
    lead = len(expanded) - len(expanded.lstrip(' '))
    text = '\u00a0' * lead + expanded.lstrip(' ') if expanded.strip() else ''
    # 超宽保护：SarasaMonoSC 7.9pt 实测折行
    limit = AVAIL_W - 26
    if text and stringWidth(text.replace('\u00a0', ' '), 'SarasaMonoSC', 7.9) > limit:
        plain = line.replace('\t', '    ')
        out, cur = [], ''
        for ch in plain:
            if stringWidth(cur + ch, 'SarasaMonoSC', 7.9) > limit - 14:
                out.append(cur)
                cur = '        ' + ch
            else:
                cur += ch
        out.append(cur)
        paras = []
        for i, seg in enumerate(out):
            seg_e = esc(seg)
            lead2 = len(seg_e) - len(seg_e.lstrip(' '))
            paras.append(Paragraph('\u00a0' * lead2 + seg_e.lstrip(' '), S['code']))
        return paras
    return [Paragraph(text if text else '\u00a0', S['code'])]


def code_block(lines):
    """代码块 → 单列表格（CARD_BG + ACCENT 左边线；行级 Paragraph 可自然跨页）。"""
    rows = []
    for ln in lines:
        rows.append(code_line_para(ln) if isinstance(ln, str) else ln)
    flat = []
    for item in rows:
        if isinstance(item, list):
            flat.extend(item)
        else:
            flat.append(item)
    t = Table([[p] for p in flat], colWidths=[AVAIL_W], hAlign='CENTER')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), CARD_BG),
        ('LINEBEFORE', (0, 0), (0, -1), 2.0, ACCENT),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 0.6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0.6),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return t


def col_ratios(header, sample_rows):
    """按列内容测宽（CJK 记 2.0、ASCII 记 1.0），夹上下限后归一化。"""
    ncol = len(header)
    weights = [0.0] * ncol
    for row in [header] + sample_rows:
        for i in range(ncol):
            cell = row[i] if i < len(row) else ''
            w = sum(2.0 if ord(c) > 0x2E80 else 1.0 for c in cell)
            weights[i] = max(weights[i], min(w, 60.0))
    weights = [max(w, 3.0) for w in weights]
    total = sum(weights)
    fracs = [w / total for w in weights]
    floor = 0.10 if ncol <= 3 else 0.08
    fracs = [max(f, floor) for f in fracs]
    total = sum(fracs)
    return [f / total for f in fracs]


def split_md_row(line):
    r"""表格行 → 单元格列表：仅按非转义 | 切分，再还原 \|。"""
    s = line.strip()
    if s.startswith('|'):
        s = s[1:]
    if s.endswith('|'):
        s = s[:-1]
    cells = re.split(r'(?<!\\)\|', s)
    return [c.replace('\\|', '|').strip() for c in cells]


def is_sep_row(cells):
    return bool(cells) and all(re.fullmatch(r':?-{2,}:?', c.strip() or '-') for c in cells)


def md_table(rows):
    header = rows[0]
    body = [r for r in rows[1:] if not is_sep_row(r)]
    ncol = len(header)
    fracs = col_ratios(header, body)
    widths = [f * AVAIL_W * 0.985 for f in fracs]
    data = [[Paragraph('<b>%s</b>' % inline(c), S['th']) for c in header]]
    for r in body:
        cells = list(r) + [''] * (ncol - len(r))
        data.append([Paragraph(inline(c), S['td']) for c in cells[:ncol]])
    t = Table(data, colWidths=widths, hAlign='CENTER', repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), HEADER_FILL),
        ('VALIGN', (0, 0), (-1, 0), 'MIDDLE'),
        ('VALIGN', (0, 1), (-1, -1), 'TOP'),
        ('GRID', (0, 0), (-1, -1), 0.5, BORDER),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 4.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4.5),
    ]
    for i in range(1, len(data)):
        style.append(('BACKGROUND', (0, i), (-1, i),
                      TABLE_STRIPE if i % 2 == 0 else colors.white))
    t.setStyle(TableStyle(style))
    return t


def safe_keep_together(elements):
    total_h = 0
    for el in elements:
        try:
            _, h = el.wrap(AVAIL_W, PAGE_H)
        except Exception:
            h = 0
        total_h += h
    if total_h <= MAX_KEEP_HEIGHT:
        return [KeepTogether(elements)]
    if len(elements) >= 2:
        return [KeepTogether(elements[:2])] + list(elements[2:])
    return list(elements)


# ---------- TOC 文档模板（TOC Gate：TocDocTemplate + multiBuild） ----------
class TocDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, 'bookmark_name'):
            level = getattr(flowable, 'bookmark_level', 0)
            text = getattr(flowable, 'bookmark_text', '')
            key = getattr(flowable, 'bookmark_key', '')
            self.notify('TOCEntry', (level, text, self.page, key))


def add_heading(text, style, level=0):
    key = 'h_%s' % hashlib.md5(text.encode()).hexdigest()[:8]
    p = Paragraph('<a name="%s"/><b>%s</b>' % (key, inline(text)), style)
    p.bookmark_name = key
    p.bookmark_level = level
    p.bookmark_text = text
    p.bookmark_key = key
    return p


def on_page(canvas, doc):
    canvas.saveState()
    # 页眉：文档名（CJK → 必须用 NotoSerifSC，canvas.drawString 不吃自动回退）
    canvas.setFont('NotoSerifSC', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, PAGE_H - 36, DOC_TITLE)
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1.1)
    canvas.line(MARGIN, PAGE_H - 42, PAGE_W - MARGIN, PAGE_H - 42)
    # 页脚：浅线 + 左署名 + 右页码
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 42, PAGE_W - MARGIN, 42)
    canvas.setFont('NotoSerifSC', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(MARGIN, 30, 'hyyLab · binance-radar · 纯模拟交易（不接真实下单）')
    canvas.drawRightString(PAGE_W - MARGIN, 30, '第 %d 页' % doc.page)
    canvas.restoreState()


# ---------- MD 解析 ----------
H1_RE = re.compile(r'^## (.+)$')
H2_RE = re.compile(r'^### (.+)$')
BULLET_RE = re.compile(r'^- (.+)$')
NUM_RE = re.compile(r'^(\d+)\. (.+)$')


def parse_md(path):
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    raw = re.sub(r'<!--.*?-->', '', raw, flags=re.S)
    lines = raw.split('\n')

    story = []
    i, n = 0, len(lines)
    first_h1 = True
    while i < n:
        ln = lines[i]

        if ln.startswith('```'):                      # 代码块
            i += 1
            buf = []
            while i < n and not lines[i].startswith('```'):
                buf.append(lines[i])
                i += 1
            i += 1  # 跳过结束围栏
            block = code_block(buf)
            story.append(Spacer(1, 5))
            story.append(block)
            story.append(Spacer(1, 9))
            continue

        m = H1_RE.match(ln)
        if m:
            title = m.group(1).strip()
            if first_h1:
                story.append(CondPageBreak(AVAIL_H * 0.05))
                first_h1 = False
            else:
                story.append(CondPageBreak(AVAIL_H * 0.24))
            h = add_heading(title, S['h1'], level=0)
            rule = HRFlowable(width='100%', thickness=1.1, color=ACCENT,
                              spaceBefore=2, spaceAfter=9)
            story.extend([h, rule])
            i += 1
            continue

        m = H2_RE.match(ln)
        if m:
            story.append(CondPageBreak(AVAIL_H * 0.12))
            story.append(add_heading(m.group(1).strip(), S['h2'], level=1))
            i += 1
            continue

        if ln.startswith('|'):                        # 表格
            rows = []
            while i < n and lines[i].startswith('|'):
                rows.append(split_md_row(lines[i]))
                i += 1
            if len(rows) >= 3:
                story.append(Spacer(1, 6))
                story.append(md_table(rows))
                story.append(Spacer(1, 10))
            continue

        if ln.strip() == '---':                       # 分隔线
            story.append(Spacer(1, 4))
            story.append(HRFlowable(width='100%', thickness=0.6, color=BORDER,
                                    spaceBefore=4, spaceAfter=10))
            i += 1
            continue

        if ln.startswith('>'):                        # 引用块（连续行合并）
            buf = []
            while i < n and lines[i].startswith('>'):
                buf.append(lines[i].lstrip('>').strip())
                i += 1
            q = Paragraph(inline(' '.join(x for x in buf if x)), S['quote'])
            qt = Table([[q]], colWidths=[AVAIL_W], hAlign='CENTER')
            qt.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), CARD_BG),
                ('LINEBEFORE', (0, 0), (0, -1), 2.2, ICON),
                ('LEFTPADDING', (0, 0), (-1, -1), 12),
                ('RIGHTPADDING', (0, 0), (-1, -1), 10),
                ('TOPPADDING', (0, 0), (-1, -1), 7),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ]))
            story.extend([Spacer(1, 3), qt, Spacer(1, 8)])
            continue

        m = BULLET_RE.match(ln)
        if m:
            story.append(Paragraph(inline(m.group(1)), S['bullet'], bulletText='•'))
            i += 1
            continue

        m = NUM_RE.match(ln)
        if m:
            story.append(Paragraph(inline('%s. %s' % (m.group(1), m.group(2))),
                                   S['numbered']))
            i += 1
            continue

        if ln.strip() == '':
            i += 1
            continue

        if ln.startswith('# '):                       # 文档主标题：封面已承载，跳过
            i += 1
            continue

        story.append(Paragraph(inline(ln.strip()), S['body']))
        i += 1
    return story


def main():
    os.makedirs(os.path.dirname(OUT_PDF), exist_ok=True)
    story = []
    # 目录页（封面由 Playwright 渲染后合并，正文从目录起）
    story.append(Paragraph('<b>目录</b>', S['toc_title']))
    toc = TableOfContents()
    toc.levelStyles = [S['toc0'], S['toc1']]
    story.append(toc)
    story.append(PageBreak())

    story.extend(parse_md(MD_PATH))

    doc = TocDocTemplate(
        OUT_PDF, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=TOP_MARGIN, bottomMargin=BOTTOM_MARGIN,
        title='趋势自动交易 · 算法（策略）接口文档',
        author='hyyLab',
        creator='Z.ai',
        subject='TrendStrategy 通用算法接口：契约、数据、硬规则、示例与接入四步',
    )
    doc.multiBuild(story, onFirstPage=on_page, onLaterPages=on_page)
    print('body.pdf 生成完成：%s' % OUT_PDF)


if __name__ == '__main__':
    main()
