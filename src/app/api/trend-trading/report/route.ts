import { NextResponse } from 'next/server';
import { buildTrendReportData, renderReportMarkdown } from '@/lib/market/trend-trade/report';

export const dynamic = 'force-dynamic';

/**
 * 趋势自动模拟交易 · 历史分析报告导出（Task 80）
 * GET /api/trend-trading/report            → Markdown 附件下载（受众 LLM，投喂 AI 优化算法）
 * GET /api/trend-trading/report?format=json → 结构化 JSON（程序化复用）
 *
 * 口径与 /api/trend-trading/trades 完全一致：meta.side = 模型信号侧，
 * pos.side = 执行侧，reversed = 二者不一致；主口径净盈亏 = netPnlWithSlip。
 */
export async function GET(req: Request) {
  try {
    const format = new URL(req.url).searchParams.get('format') ?? 'md';
    const data = await buildTrendReportData();

    if (format === 'json') {
      return NextResponse.json(
        { ok: true, ts: Date.now(), report: data },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // 文件名时间戳取 UTC+8（与报告正文时间戳口径一致）
    const d = new Date(data.generatedAtMs + 8 * 3_600_000);
    const iso = d.toISOString();
    const stamp = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
    return new NextResponse(renderReportMarkdown(data), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="trend-report-${stamp}.md"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'trend report error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
