#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Task 65 第二轮：大盈/大亏样本的信号细节归因（只读）。"""
import json, sqlite3
from collections import Counter

db = sqlite3.connect('db/custom.db')
db.row_factory = sqlite3.Row

rows = db.execute("""
  SELECT m.positionId, m.symbol, m.side, m.scoreAtOpen, m.featuresAtOpen, m.signalAtOpen,
         m.exitReason, m.exitSignalJson, m.netPnlWithSlip, m.openDecisionAt, m.closedAt,
         m.entryEr, m.htf5mDir, m.entryRound, m.trendCycleId, m.mfe, m.mae, m.mfeDrawdown,
         m.exitEvidenceBars, p.margin
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
    d['modeTag'] = feat.get('modeTag', '-')
    try:
        sig = json.loads(r['signalAtOpen'] or '{}')
        d['openReason'] = (sig.get('reason') or '')[:90]
        d['openPhase'] = sig.get('phase')
    except Exception:
        d['openReason'] = ''
    try:
        ex = json.loads(r['exitSignalJson'] or '{}')
        d['exitScore'] = ex.get('score')
        d['exitPhase'] = ex.get('phase')
        d['exitReasonText'] = (ex.get('reason') or '')[:80]
        d['exitEvidence'] = ex.get('endEvidenceBars')
    except Exception:
        pass
    d['pnl'] = r['netPnlWithSlip'] or 0
    d['roi'] = d['pnl'] / r['margin'] * 100 if r['margin'] else 0
    d['holdMin'] = ((r['closedAt'] or 0) - (r['openDecisionAt'] or 0)) / 60000
    sw.append(d)

wins = sorted([t for t in sw if t['pnl'] > 0], key=lambda t: -t['pnl'])
loss = sorted([t for t in sw if t['pnl'] < 0], key=lambda t: t['pnl'])

print('===== 大盈前 8 笔 · 信号细节 =====')
for t in wins[:8]:
    print(f"{t['symbol']:<10}{t['side']:<6}{t['pnl']:+7.2f}U ROI{t['roi']:+7.1f}% 持{t['holdMin']:.0f}分 "
          f"入分{t['scoreAtOpen']:.0f} ER{t['entryEr']:.2f} R{t['entryRound']} [{t['exitReason']}] "
          f"离场分{t.get('exitScore', '-')} MFE{(t['mfe'] or 0)*100:+.0f}% MAE{(t['mae'] or 0)*100:+.0f}%")
    print(f"   入场理由: {t['openReason']}")

print()
print('===== 大亏前 8 笔 · 信号细节 =====')
for t in loss[:8]:
    print(f"{t['symbol']:<10}{t['side']:<6}{t['pnl']:+7.2f}U ROI{t['roi']:+7.1f}% 持{t['holdMin']:.0f}分 "
          f"入分{t['scoreAtOpen']:.0f} ER{t['entryEr']:.2f} R{t['entryRound']} [{t['exitReason']}] "
          f"离场分{t.get('exitScore', '-')} MFE{(t['mfe'] or 0)*100:+.0f}% MAE{(t['mae'] or 0)*100:+.0f}%")
    print(f"   入场理由: {t['openReason']}")
    print(f"   离场时点: phase={t.get('exitPhase')} 离场理由={t.get('exitReasonText')}")

# ===== 大亏单画像 =====
print()
print('===== 亏损组画像 =====')
mae_deep = [t for t in loss if (t['mae'] or 0) * 100 <= -1000]  # 保证金口径 -10x = 价格逆行 0.5%（20x）
print(f"MAE ≤ -1000%（价格逆行 ≥0.5%，20x 下即 -20% 保证金）: {len(mae_deep)}/{len(loss)} 笔")
for t in mae_deep[:8]:
    print(f"  {t['symbol']:<10} MAE{(t['mae'])*100:+7.0f}% 终局{t['pnl']:+6.2f}U 持{t['holdMin']:.0f}分 [{t['exitReason']}]")

# MFE 为正（曾有浮盈）但最终亏损 = 「浮盈没落袋→走弱割肉」型
had_profit_then_loss = [t for t in loss if (t['mfe'] or 0) * 100 >= 200]
print(f"\n曾有 ≥200% 保证金浮盈却最终亏损（冲高没落袋型）: {len(had_profit_then_loss)}/{len(loss)} 笔")
for t in had_profit_then_loss[:8]:
    print(f"  {t['symbol']:<10} MFE{(t['mfe'])*100:+7.0f}% → 终局{t['pnl']:+6.2f}U 持{t['holdMin']:.0f}分 [{t['exitReason']}]")

# 立即逆行型：MFE 很浅（<100%）且 MAE 深
straight_loss = [t for t in loss if (t['mfe'] or 0) * 100 < 100 and (t['mae'] or 0) * 100 <= -500]
print(f"\n入场即逆行（MFE<100% 且 MAE≤-500%）: {len(straight_loss)}/{len(loss)} 笔")

# ===== 同币连环：大亏是否紧跟在大盈后（同周期第 2 轮再入场）=====
print()
print('===== 同币连环开仓（同 trendCycleId 内 2 轮的盈亏配对）=====')
from collections import defaultdict
cycles = defaultdict(list)
for t in sw:
    cycles[t['trendCycleId']].append(t)
multi = {k: sorted(v, key=lambda x: x['openDecisionAt']) for k, v in cycles.items() if len(v) >= 2}
print(f"同周期多轮开仓的周期数: {len(multi)}")
for k, ts in sorted(multi.items(), key=lambda kv: sum(t['pnl'] for t in kv[1]))[:6]:
    pnls = ' '.join(f"{t['pnl']:+.2f}({t['exitReason'][:5]})" for t in ts)
    print(f"  {ts[0]['symbol']:<10} {pnls}  合计 {sum(t['pnl'] for t in ts):+.2f}U")

# ===== 时间聚集性 =====
print()
print('===== 按小时盈亏分布 =====')
hours = defaultdict(lambda: [0, 0.0])
for t in sw:
    h = __import__('datetime').datetime.fromtimestamp(t['openDecisionAt'] / 1000).strftime('%m-%d %H时')
    hours[h][0] += 1
    hours[h][1] += t['pnl']
for h in sorted(hours):
    n, s = hours[h]
    print(f"  {h}  n={n:<3} {s:+8.2f}U")
