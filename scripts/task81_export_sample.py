#!/usr/bin/env python3
# Task 81: 从 DB 导出反向模式已平仓全量逐笔数据(回测正向算法的源数据)
# 口径: meta.side=模型侧, pos.side=执行侧, netPnlWithSlip=反向(执行侧)净盈亏
#       正向镜像 pnl = -netPnlWithSlip (LIQUIDATED 2 笔按 §8 口径计入 +margin, 标注 liq=True)
import sqlite3, json, os

db = sqlite3.connect('/home/z/my-project/db/custom.db')
db.row_factory = sqlite3.Row
cur = db.cursor()

rows = cur.execute("""
  SELECT m.positionId, m.trendCycleId, m.symbol, m.side AS modelSide, m.status,
         m.trendPhaseAtOpen, m.scoreAtOpen, m.entryEr, m.htf5mDir, m.htf15mDir, m.htfGate,
         m.mfe, m.mae, m.mfeDrawdown, m.netPnlWithSlip, m.entryRound, m.exitReason, m.exitEvidenceBars,
         m.featuresAtOpen, m.signalAtOpen, m.closedAt,
         p.side AS execSide, p.margin, p.leverage, p.openedAt, p.pnl AS rawPnl, p.exitPrice, p.entryPrice
  FROM TrendTradeMeta m LEFT JOIN PaperPosition p ON p.id = m.positionId
  WHERE m.status = 'CLOSED'
  ORDER BY m.closedAt ASC
""").fetchall()

out = []
for r in rows:
    feats, sig = {}, {}
    try: feats = json.loads(r['featuresAtOpen'] or '{}')
    except Exception: pass
    try: sig = json.loads(r['signalAtOpen'] or '{}')
    except Exception: pass
    vol = feats.get('vol') or {}
    htf5m = feats.get('htf5m') or {}
    htf15m = feats.get('htf15m') or {}
    closedMs = r['closedAt']; openedMs = r['openedAt']
    def ms(v):
        if v is None: return None
        return v if isinstance(v, (int, float)) else sqlite3.utils  # unreachable guard
    # sqlite 返回字符串时间戳(引擎写入为 ms 数字字符串)或 ISO——统一解析
    def to_ms(v):
        if v is None: return None
        if isinstance(v, (int, float)): return float(v)
        s = str(v)
        try: return float(s)
        except ValueError: pass
        from datetime import datetime
        try: return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000
        except Exception: return None
    cMs, oMs = to_ms(closedMs), to_ms(openedMs)
    out.append({
        'positionId': r['positionId'],
        'symbol': r['symbol'],
        'modelSide': r['modelSide'],
        'execSide': r['execSide'],
        'reversed': r['modelSide'] != r['execSide'],
        'exitReason': r['exitReason'],
        'liquidated': (r['exitReason'] == 'LIQUIDATED') or (r['status'] == 'CLOSED' and r['exitReason'] is None and False),
        'scoreAtOpen': r['scoreAtOpen'],
        'entryEr': r['entryEr'],
        'htf5mDir': r['htf5mDir'],
        'htf15mDir': r['htf15mDir'],
        'htfGate': r['htfGate'],
        'mfeModel': r['mfe'],       # 模型侧最大浮盈(= 正向视角浮盈, 正向可用)
        'maeModel': r['mae'],       # 模型侧最大浮亏(= 正向视角浮亏, 正向止损 what-if 可用)
        'mfeDrawdown': r['mfeDrawdown'],
        'netPnlReverse': r['netPnlWithSlip'],  # 反向(执行侧)净盈亏
        'margin': r['margin'],
        'leverage': r['leverage'],
        'entryRound': r['entryRound'],
        'closedAtMs': cMs,
        'openedAtMs': oMs,
        'holdMinutes': (cMs - oMs) / 60000 if (cMs and oMs) else None,
        'breakout': sig.get('breakout') if isinstance(sig, dict) else None,
        'volRegime': vol.get('volRegime'),
        'htfAgree': feats.get('htfAgree'),
        'strength': feats.get('strength'),
        'exitEvidenceBars': r['exitEvidenceBars'],
    })

os.makedirs('/home/z/my-project/scripts/data', exist_ok=True)
with open('/home/z/my-project/scripts/data/reverse-sample.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

# 快速校验:与报告 §3/§8 对账(反向口径)
n = len(out)
net = sum(t['netPnlReverse'] or 0 for t in out)
liq = sum(1 for t in out if t['exitReason'] == 'LIQUIDATED')
rev = sum(1 for t in out if t['reversed'])
print(f'exported {n} closed | reversed {rev} | liq {liq} | reverse net {net:+.2f}')
print(f'forward mirror net = {-net:+.2f} (report §8: +25.95 on 130 trades window)')
