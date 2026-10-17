#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 65（只读分析）：短周期套利（short-swing-v1）已平仓交易的盈亏两端归因统计。
不修改任何数据、不写 worklog。"""
import json, sqlite3
from datetime import datetime

db = sqlite3.connect('db/custom.db')
db.row_factory = sqlite3.Row

TZ = datetime.fromtimestamp  # 本机时区即用户时区展示

def ts(ms):
    return TZ(ms / 1000).strftime('%m-%d %H:%M') if ms else '-'

rows = db.execute("""
  SELECT m.positionId, m.symbol, m.side, m.scoreAtOpen, m.featuresAtOpen,
         m.signalAtOpen, m.exitReason, m.exitEndReason, m.exitEvidenceBars,
         m.netPnlWithSlip, m.openDecisionAt, m.closedAt, m.entryEr,
         m.htf5mDir, m.htf15mDir, m.htfGate, m.entryRound, m.trendCycleId,
         m.mfe, m.mae, m.mfeDrawdown, m.entryNotional, m.closeNotional,
         p.margin, p.leverage, p.entryPrice, p.exitPrice
  FROM TrendTradeMeta m JOIN PaperPosition p ON p.id = m.positionId
  WHERE m.status = 'CLOSED'
""").fetchall()

sw = []
for r in rows:
    try:
        feat = json.loads(r['featuresAtOpen'] or '{}')
    except Exception:
        feat = {}
    if feat.get('strategyId') != 'short-swing-v1':
        continue
    d = dict(r)
    d['feat'] = feat
    # 入场模式标签（modeTag 存在 featuresAtOpen 快照里）
    d['modeTag'] = feat.get('modeTag', '-')
    d['reason'] = feat.get('reason', '')
    margin = r['margin'] or 0
    pnl = r['netPnlWithSlip'] or 0
    d['margin'] = margin
    d['pnl'] = pnl
    d['roi'] = (pnl / margin * 100) if margin > 0 else 0
    d['holdMin'] = ((r['closedAt'] or 0) - (r['openDecisionAt'] or 0)) / 60000
    sw.append(d)

print(f"短周期套利已平仓：{len(sw)} 笔（其余 {len(rows)-len(sw)} 笔为通用趋势引擎）")
wins = [t for t in sw if t['pnl'] > 0]
loss = [t for t in sw if t['pnl'] < 0]
print(f"盈利 {len(wins)} 笔 / 亏损 {len(loss)} 笔 | 合计净盈亏 {sum(t['pnl'] for t in sw):+.2f} U")
print(f"平均盈利 {sum(t['pnl'] for t in wins)/max(len(wins),1):+.2f} U | 平均亏损 {sum(t['pnl'] for t in loss)/max(len(loss),1):+.2f} U")
print()

def show(title, trades, n):
    print('=' * 100)
    print(f"{title}（按净盈亏排序，前 {n} 笔）")
    print('=' * 100)
    hdr = f"{'时间':<12}{'币':<10}{'向':<6}{'模式':<16}{'分':>4}{'ER':>5}{'5m':>8}{'轮':>3}{'持分':>6}{'净PnL':>9}{'ROI%':>8}{'MFE%':>7}{'MAE%':>7} 离场原因"
    print(hdr)
    for t in trades[:n]:
        mfe = (t['mfe'] or 0) * 100 if t['mfe'] is not None else 0
        mae = (t['mae'] or 0) * 100 if t['mae'] is not None else 0
        print(f"{ts(t['openDecisionAt']):<12}{t['symbol'][:9]:<10}{t['side']:<6}"
              f"{str(t['modeTag'])[:15]:<16}{t['scoreAtOpen'] if t['scoreAtOpen'] is not None else '-':>4}"
              f"{t['entryEr'] if t['entryEr'] is not None else 0:>5.2f}"
              f"{(t['htf5mDir'] or '-')[:7]:>8}{t['entryRound'] or 1:>3}"
              f"{t['holdMin']:>6.0f}{t['pnl']:>+9.2f}{t['roi']:>+8.1f}"
              f"{mfe:>+7.1f}{mae:>+7.1f} {t['exitReason'] or '?'}"
              + (f" / {t['exitEndReason']}" if t['exitEndReason'] and t['exitEndReason'] != t['exitReason'] else ''))

show('盈利最大', sorted(sw, key=lambda t: -t['pnl']), 10)
show('亏损最大', sorted(sw, key=lambda t: t['pnl']), 10)

# ===== 维度聚合（盈/亏两组对比）=====
def agg(group, label):
    if not group:
        print(f"\n[{label}] 无样本")
        return
    n = len(group)
    print(f"\n[{label}] n={n} 净盈亏合计 {sum(t['pnl'] for t in group):+.2f} U")
    from collections import Counter
    er = Counter(t['exitReason'] or '?' for t in group)
    print('  离场原因分布:', ', '.join(f'{k}×{v}' for k, v in er.most_common()))
    md = Counter(t['modeTag'] for t in group)
    print('  入场模式分布:', ', '.join(f'{k}×{v}' for k, v in md.most_common()))
    hd = Counter(t['htf5mDir'] or '-' for t in group)
    print('  5m背景分布 :', ', '.join(f'{k}×{v}' for k, v in hd.most_common()))
    sd = Counter(t['side'] for t in group)
    print('  多空分布   :', ', '.join(f'{k}×{v}' for k, v in sd.most_common()))
    avg = lambda k: sum(t[k] or 0 for t in group) / n
    print(f"  均值: 入场分 {avg('scoreAtOpen'):.0f} | ER {avg('entryEr'):.2f} | 持仓 {avg('holdMin'):.0f} 分钟 | MFE {avg('mfe')*100 if group[0]['mfe'] is not None else 0:+.1f}% | MAE {avg('mae')*100 if group[0]['mae'] is not None else 0:+.1f}%")

agg(wins, '盈利组')
agg(loss, '亏损组')

# ===== 离场原因 × 盈亏 交叉表 =====
print('\n[离场原因 × 盈亏交叉]')
from collections import defaultdict
cross = defaultdict(lambda: [0, 0.0, 0.0])  # reason -> [n, pnl_sum, pnl_max_abs]
for t in sw:
    c = cross[t['exitReason'] or '?']
    c[0] += 1
    c[1] += t['pnl']
    c[2] = max(c[2], abs(t['pnl']))
for k, (n, s, mx) in sorted(cross.items(), key=lambda kv: kv[1][1]):
    print(f"  {k:<20} n={n:<4} 合计 {s:+9.2f} U | 单笔最大绝对值 {mx:.2f} U")

# ===== 入场模式 × 盈亏 交叉表 =====
print('\n[入场模式 × 盈亏交叉]')
cross2 = defaultdict(lambda: [0, 0.0, 0])
for t in sw:
    c = cross2[t['modeTag']]
    c[0] += 1
    c[1] += t['pnl']
    c[2] += 1 if t['pnl'] > 0 else 0
for k, (n, s, w) in cross2.items():
    print(f"  {k:<20} n={n:<4} 合计 {s:+9.2f} U | 胜率 {w/n*100:.0f}%")

# ===== 轮次 × 盈亏 =====
print('\n[轮次 × 盈亏交叉]')
cross3 = defaultdict(lambda: [0, 0.0, 0])
for t in sw:
    c = cross3[t['entryRound'] or 1]
    c[0] += 1
    c[1] += t['pnl']
    c[2] += 1 if t['pnl'] > 0 else 0
for k in sorted(cross3):
    n, s, w = cross3[k]
    print(f"  第{k}轮  n={n:<4} 合计 {s:+9.2f} U | 胜率 {w/n*100:.0f}%")

# ===== 典型大亏/大盈样本的入场理由原文 =====
print('\n[大亏前3笔的入场理由原文]')
for t in sorted(sw, key=lambda x: x['pnl'])[:3]:
    print(f"  {t['symbol']} {t['side']} {t['pnl']:+.2f}U: {t['reason'][:120]}")
print('\n[大盈前3笔的入场理由原文]')
for t in sorted(sw, key=lambda x: -x['pnl'])[:3]:
    print(f"  {t['symbol']} {t['side']} {t['pnl']:+.2f}U: {t['reason'][:120]}")
