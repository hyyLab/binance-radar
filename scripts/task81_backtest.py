#!/usr/bin/env python3
# Task 81: 正向算法回测(基于反向样本的逐笔镜像)
# 口径:
#   forwardPnl = -netPnlReverse; LIQUIDATED 2 笔按报告 §8 口径 = +margin(正向世界可能仍持有, 估值)
#   maeModel/mfeModel 本就是模型侧(正向视角)路径数据 → 正向止损 what-if 直接可用
# 方法论边界:这是「事件研究」——过滤器只改变入场集合,不改变已发生路径;
#   止损改写用 MAE 极值近似(先亏后赚单在 -S 截断), TRAIL 参数无法回测(无逐 tick 路径)。
import json

D = json.load(open('/home/z/my-project/scripts/data/reverse-sample.json', encoding='utf-8'))

def fwd_pnl(t):
    if t['exitReason'] == 'LIQUIDATED':
        return t['margin'] or 0.0   # §8 口径: 反向 -margin → 正向 +margin
    return -(t['netPnlReverse'] or 0.0)

for t in D:
    t['fwdPnl'] = fwd_pnl(t)
    t['fwdPct'] = (t['fwdPnl'] / t['margin'] * 100) if t['margin'] else 0.0

def stats(trades):
    n = len(trades)
    if n == 0: return dict(n=0, net=0, pf=None, wr=None, exp=0, liq=0)
    net = sum(t['fwdPnl'] for t in trades)
    gw = sum(t['fwdPnl'] for t in trades if t['fwdPnl'] > 0)
    gl = sum(t['fwdPnl'] for t in trades if t['fwdPnl'] <= 0)
    pf = gw / abs(gl) if gl < 0 else float('inf')
    wr = sum(1 for t in trades if t['fwdPnl'] > 0) / n * 100
    return dict(n=n, net=net, pf=pf, wr=wr, exp=net / n, liq=sum(1 for t in trades if t['exitReason']=='LIQUIDATED'))

def line(label, s):
    pf = f"{s['pf']:.2f}" if s['pf'] is not None and s['pf'] != float('inf') else ('inf' if s['pf']==float('inf') else '—')
    wr = f"{s['wr']:.1f}" if s['wr'] is not None else '—'
    print(f"| {label} | {s['n']} | {s['net']:+.2f} | {pf} | {wr}% | {s['exp']:+.2f} | {s['liq']} |")

print('=== 基准(全部 131 笔正向镜像) ===')
print('| 集合 | n | netPnl | PF | winRate | expectancy | liq |')
print('|---|---|---|---|---|---|---|')
line('ALL(正向镜像)', stats(D))

# 按平仓原因(正向视角)
print()
print('=== 按退出原因(正向视角) ===')
print('| exit | n | netPnl | PF | winRate | expectancy | liq |')
print('|---|---|---|---|---|---|---|')
for r in sorted({t['exitReason'] for t in D}):
    line(r, stats([t for t in D if t['exitReason']==r]))

# 评分门槛扫描
print()
print('=== 评分门槛扫描(scoreAtOpen >= X) ===')
print('| score>= | n | netPnl | PF | winRate | expectancy | liq |')
print('|---|---|---|---|---|---|---|')
for x in [0, 40, 50, 55, 60, 62, 65, 68, 70, 72, 75, 80]:
    line(f'>={x}', stats([t for t in D if (t['scoreAtOpen'] or 0) >= x]))

# HTF 门控(正向视角)
print()
print('=== HTF 门控(正向视角) ===')
print('| htfGate | n | netPnl | PF | winRate | expectancy | liq |')
print('|---|---|---|---|---|---|---|')
for g in ['ALIGNED', 'NEUTRAL', 'OPPOSED']:
    line(g, stats([t for t in D if t['htfGate']==g]))
line('非 OPPOSED', stats([t for t in D if t['htfGate']!='OPPOSED']))

# 模型方向(正向视角)
print()
print('=== 模型方向(正向) ===')
print('| side | n | netPnl | PF | winRate | expectancy | liq |')
print('|---|---|---|---|---|---|---|')
line('model SHORT', stats([t for t in D if t['modelSide']=='SHORT']))
line('model LONG', stats([t for t in D if t['modelSide']=='LONG']))

# 交叉:score 门槛 × HTF
print()
print('=== 交叉:score>=X × htfGate(净利) ===')
print('| score>= | ALL | 非OPP | ALIGNED | NEUTRAL | ALI+NEU |')
print('|---|---|---|---|---|---|')
for x in [0, 50, 60, 65, 70, 75]:
    row = [f'>={x}']
    for flt in [lambda t: True,
                lambda t: t['htfGate']!='OPPOSED',
                lambda t: t['htfGate']=='ALIGNED',
                lambda t: t['htfGate']=='NEUTRAL',
                lambda t: t['htfGate'] in ('ALIGNED','NEUTRAL')]:
        s = stats([t for t in D if (t['scoreAtOpen'] or 0) >= x and flt(t)])
        row.append(f"{s['net']:+.1f}({s['n']})")
    print('| ' + ' | '.join(row) + ' |')

# 正向止损 what-if(基于 maeModel, 正向路径):先过滤(score>=X, 非OPP)再扫档
def with_stop(trades, S):
    out = []
    for t in trades:
        mae = t['maeModel']
        if mae is not None and mae <= -S:
            out.append({**t, 'fwdPnl': -(t['margin'] or 0) * S / 100, 'fwdPct': -S})
        else:
            out.append(t)
    return out

print()
print('=== 止损 what-if(正向, maeModel 截断) ===')
print('| 集合 | stop% | n | netPnl | PF | delta |')
print('|---|---|---|---|---|---|')
for name, flt in [('ALL', lambda t: True),
                  ('score>=70', lambda t: (t['scoreAtOpen'] or 0) >= 70),
                  ('score>=65 非OPP', lambda t: (t['scoreAtOpen'] or 0) >= 65 and t['htfGate']!='OPPOSED'),
                  ('score>=60 非OPP', lambda t: (t['scoreAtOpen'] or 0) >= 60 and t['htfGate']!='OPPOSED')]:
    base = [t for t in D if flt(t)]
    for S in [0, 20, 30, 40, 50]:
        s = stats(with_stop(base, S)) if S else stats(base)
        b = stats(base)
        pf = f"{s['pf']:.2f}" if s['pf'] is not None and s['pf'] != float('inf') else 'inf'
        print(f"| {name} | -{S} | {s['n']} | {s['net']:+.2f} | {pf} | {s['net']-b['net']:+.2f} |")

# 特征深挖:entryEr / breakout / volRegime / strength / htfAgree
print()
print('=== 入场特征单维(正向) ===')
print('| 特征 | n | netPnl | PF | winRate | expectancy |')
print('|---|---|---|---|---|---|')
er = [t for t in D if t['entryEr'] is not None]
line(f'entryEr>=0.3({len(er)})', stats(er))
line('entryEr<0.3', stats([t for t in D if t['entryEr'] is not None and t['entryEr'] < 0.3]))
bo_same = [t for t in D if t['breakout'] and ((t['modelSide']=='LONG' and t['breakout']=='up') or (t['modelSide']=='SHORT' and t['breakout']=='down'))]
line(f'breakout同向({len(bo_same)})', stats(bo_same))
line('breakout非同向/缺', stats([t for t in D if t not in bo_same]))
for vr in sorted({str(t['volRegime']) for t in D}):
    line(f'vol={vr}', stats([t for t in D if str(t['volRegime'])==vr]))
for ha in sorted({str(t['htfAgree']) for t in D}):
    line(f'htfAgree={ha}', stats([t for t in D if str(t['htfAgree'])==ha]))

# 时间稳定性:按 closedAt 三等分看前沿组合是否全期成立
print()
print('=== 时间三分(稳健性粗查; 样本为 4 小时单 regime, 仅参考) ===')
srt = sorted(D, key=lambda t: t['closedAtMs'] or 0)
k = len(srt) // 3
buckets = [srt[:k], srt[k:2*k], srt[2*k:]]
print('| 组合 | 前1/3 | 中1/3 | 后1/3 |')
print('|---|---|---|---|')
combos = [
    ('ALL', lambda t: True),
    ('score>=70', lambda t: (t['scoreAtOpen'] or 0) >= 70),
    ('score>=70 非OPP', lambda t: (t['scoreAtOpen'] or 0) >= 70 and t['htfGate']!='OPPOSED'),
    ('score>=65 非OPP', lambda t: (t['scoreAtOpen'] or 0) >= 65 and t['htfGate']!='OPPOSED'),
    ('score>=60 非OPP', lambda t: (t['scoreAtOpen'] or 0) >= 60 and t['htfGate']!='OPPOSED'),
    ('score>=70 非OPP stop40', None),  # 单独处理
]
for name, flt in combos:
    if flt is None:
        row = []
        for b in buckets:
            sel = [t for t in b if (t['scoreAtOpen'] or 0) >= 70 and t['htfGate']!='OPPOSED']
            row.append(f"{stats(with_stop(sel, 40))['net']:+.1f}")
    else:
        row = [f"{stats([t for t in b if flt(t)])['net']:+.1f}" for b in buckets]
    print(f"| {name} | " + ' | '.join(row) + ' |')

# 候选组合明细
print()
print('=== 候选组合明细 ===')
print('| 组合 | n | netPnl | PF | winRate | expectancy | liq |')
print('|---|---|---|---|---|---|---|')
line('score>=70 非OPP', stats([t for t in D if (t['scoreAtOpen'] or 0) >= 70 and t['htfGate']!='OPPOSED']))
line('score>=70 非OPP +stop40', stats(with_stop([t for t in D if (t['scoreAtOpen'] or 0) >= 70 and t['htfGate']!='OPPOSED'], 40)))
line('score>=65 非OPP', stats([t for t in D if (t['scoreAtOpen'] or 0) >= 65 and t['htfGate']!='OPPOSED']))
line('score>=60 非OPP +stop40', stats(with_stop([t for t in D if (t['scoreAtOpen'] or 0) >= 60 and t['htfGate']!='OPPOSED'], 40)))
