// ---------- 参数说明书 · 装配与导出（docx skill 三节结构：封面 / 目录 / 正文） ----------
const {
  Document, Packer, Paragraph, TextRun, Header, Footer, AlignmentType,
  SectionType, NumberFormat, PageNumber, TableOfContents, PageBreak,
} = require("docx");
const fs = require("fs");
const { PALETTE, buildCoverR1 } = require("./manual-lib");
const content = require("./manual-content");

const pgSize = { width: 11906, height: 16838 };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

// ===== 封面配置（R1 + DM-1） =====
const coverConfig = {
  title: "趋势机器人参数说明书",
  subtitle: "自动开仓参数控制台 · 使用指南（短周期套利 v1）",
  englishLabel: "PARAMETER MANUAL",
  metaLines: [
    "适用算法：短周期套利 v1（short-swing-v1）",
    "控制台入口：趋势交易页 · 头部「参数」按钮",
    "适用账户：trend-auto-v1（纯模拟盘，与手动盘隔离）",
    "文档版本：v1.1（2026-10-17 · 新增保证金比例参数与满仓封顶说明）",
  ],
  footerLeft: "币安热点雷达 · 趋势自动交易",
  footerRight: "2026-10",
  palette: PALETTE,
};

function pageNumFooter() {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "888888", font: { ascii: "Times New Roman" } })],
    })],
  });
}
function docHeader() {
  return new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: "single", size: 2, color: "C8DDE2" } },
      children: [new TextRun({ text: "趋势机器人参数说明书", size: 18, color: "90989F", font: { eastAsia: "SimSun", ascii: "Times New Roman" } })],
    })],
  });
}

// ===== 目录节（TOC 标题不用 Heading；TableOfContents + 刷新提示；节间由 NEXT_PAGE 分页，不加尾部分页符防空白页） =====
const tocChildren = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: 160 },
    children: [new TextRun({ text: "目  录", bold: true, size: 32, font: { eastAsia: "SimHei", ascii: "Times New Roman" }, color: "000000" })],
  }),
  new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  new Paragraph({
    spacing: { before: 80 },
    children: [new TextRun({
      text: "注：本目录由域代码生成。编辑后如需确保页码准确，请在目录上右键选择「更新域」。",
      italics: true, size: 18, color: "888888", font: { eastAsia: "SimSun", ascii: "Times New Roman" },
    })],
  }),
];

const bodyChildren = [
  ...content.ch1,
  ...content.ch2,
  ...content.ch3,
  ...content.ch4,
  ...content.ch5,
  ...content.appendix,
];

const doc = new Document({
  creator: "Binance Radar",
  title: "趋势机器人自动开仓参数说明书",
  styles: {
    default: {
      document: {
        run: { font: { ascii: "Times New Roman", eastAsia: "SimSun" }, size: 24, color: "000000" },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: { ascii: "Times New Roman", eastAsia: "SimHei" }, size: 32, bold: true, color: PALETTE.headingColor },
        paragraph: { spacing: { before: 360, after: 160, line: 312 }, outlineLevel: 0 },
      },
      heading2: {
        run: { font: { ascii: "Times New Roman", eastAsia: "SimHei" }, size: 28, bold: true, color: PALETTE.headingColor },
        paragraph: { spacing: { before: 240, after: 120, line: 312 }, outlineLevel: 1 },
      },
    },
  },
  sections: [
    { // 第 1 节：封面（margin 0，无页码无页脚）
      properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1(coverConfig),
    },
    { // 第 2 节：目录（罗马页码 i, ii）
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
      },
      footers: { default: pageNumFooter() },
      children: tocChildren,
    },
    { // 第 3 节：正文（阿拉伯页码从 1 起）
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
      },
      headers: { default: docHeader() },
      footers: { default: pageNumFooter() },
      children: bodyChildren,
    },
  ],
});

const OUT = "/home/z/my-project/download/趋势机器人自动开仓参数说明书.docx";
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log("written:", OUT, buf.length, "bytes");
});
