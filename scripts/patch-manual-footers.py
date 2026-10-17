#!/usr/bin/env python3
"""页码后处理（toc.md 要求）：页脚 instrText 补格式开关 + 移除封面空 pgNumType（WPS 兼容）。"""
import re, shutil, sys, zipfile, os

DOC = sys.argv[1] if len(sys.argv) > 1 else "/home/z/my-project/download/趋势机器人自动开仓参数说明书.docx"
TMP = DOC + ".tmp"

with zipfile.ZipFile(DOC, "r") as zin:
    names = zin.namelist()
    items = {n: zin.read(n) for n in names}

# 1) document.xml：移除空 pgNumType（docx-js 对未设页码节也会输出，WPS 会困惑）
doc_xml = items["word/document.xml"].decode("utf-8")
doc_xml = doc_xml.replace("<w:pgNumType/>", "")

# 找出各节引用的 footer id → 对应 footerN.xml（第2节 ROMAN、第3节 arabic）
# 节顺序：sectPr 依文档流出现；第 1 节（封面）无 footerReference。
sect_refs = re.findall(r'<w:footerReference w:type="default" r:id="(rId\d+)"/>', doc_xml)
rels = items["word/_rels/document.xml.rels"].decode("utf-8")
rid2file = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(footer\d+\.xml)"', rels))
fmt_by_order = ["ROMAN", "arabic"]  # 第2节罗马、第3节阿拉伯（封面无 footer）
patched = []
for i, rid in enumerate(sect_refs[:2]):
    fname = "word/" + rid2file.get(rid, "")
    if fname not in items:
        continue
    fx = items[fname].decode("utf-8")
    fmt = fmt_by_order[i] if i < len(fmt_by_order) else "arabic"
    fx2 = re.sub(
        r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
        rf"\1 PAGE \\* {fmt} \\* MERGEFORMAT \2",
        fx,
    )
    if fx2 != fx:
        items[fname] = fx2.encode("utf-8")
        patched.append((fname, fmt))
items["word/document.xml"] = doc_xml.encode("utf-8")

with zipfile.ZipFile(TMP, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in names:
        zout.writestr(n, items[n])
shutil.move(TMP, DOC)
print("pgNumType cleaned; footers patched:", patched)
