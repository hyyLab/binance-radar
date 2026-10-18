#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Task 80：trend-trade-view.tsx 增加一键导出 AI 报告按钮（python 锚定替换，含中文行安全编辑）
import io, sys

PATH = '/home/z/my-project/src/components/trend-trade/trend-trade-view.tsx'
src = io.open(PATH, encoding='utf-8').read()

def rep(old, new, tag):
    global src
    n = src.count(old)
    assert n == 1, f'[{tag}] anchor count={n} (expect 1)'
    src = src.replace(old, new)
    print(f'ok: {tag}')

# ① 文件头任务清单补 Task 80 一行
rep(
    '''// ⚠️ 纯模拟交易；趋势评分为启发式证据分；趋势确认 ≠ 买卖指令；强平如实统计。''',
    '''// Task 80：⑨ 历史交易旁一键导出「AI 分析报告」（Markdown 附件，受众 LLM 做算法优化）
// ⚠️ 纯模拟交易；趋势评分为启发式证据分；趋势确认 ≠ 买卖指令；强平如实统计。''',
    'header-note',
)

# ② lucide 图标补 FileDown（字母序置于 CircleAlert 与 History 之间）
rep(
    '''  CircleAlert,
  History,''',
    '''  CircleAlert,
  FileDown,
  History,''',
    'lucide-import',
)

# ③ 状态 + 导出处理函数（锚定在历史折叠状态之后）
rep(
    '''  const [historyExpanded, setHistoryExpanded] = useState(false);
  const history = useTrendTradeHistory(filterSymbol, sort, order);''',
    '''  const [historyExpanded, setHistoryExpanded] = useState(false);
  const history = useTrendTradeHistory(filterSymbol, sort, order);
  // Task 80：一键导出 AI 分析报告（/api/trend-trading/report → Markdown 附件下载）
  const [reportBusy, setReportBusy] = useState(false);
  const handleExportReport = async () => {
    if (reportBusy) return;
    setReportBusy(true);
    try {
      const res = await fetch('/api/trend-trading/report');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const m = (res.headers.get('Content-Disposition') ?? '').match(/filename="?([^";]+)"?/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m?.[1] ?? 'trend-report.md';
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'AI 报告已导出', description: 'Markdown 文件已下载，可直接投喂给 AI 分析优化算法' });
    } catch (e) {
      toast({ title: '导出失败', description: e instanceof Error ? e.message : '未知错误', variant: 'destructive' });
    } finally {
      setReportBusy(false);
    }
  };''',
    'state-handler',
)

# ④ 历史交易标题行尾追加导出按钮（排序下拉之后）
rep(
    '''                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
            </div>''',
    '''                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>
              <button
                onClick={handleExportReport}
                disabled={reportBusy}
                title="导出全量历史分析报告（Markdown，供 AI 优化算法）"
                className="ml-auto flex items-center gap-1 rounded border border-gold/50 bg-gold/10 px-2 py-1 text-[11px] font-semibold text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
              >
                <FileDown className="h-3 w-3" /> {reportBusy ? '生成中…' : '导出AI报告'}
              </button>
            </div>''',
    'export-button',
)

io.open(PATH, 'w', encoding='utf-8').write(src)
print('patched:', PATH)
