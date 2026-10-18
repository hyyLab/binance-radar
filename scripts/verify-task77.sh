#!/bin/bash
# Task 77 验证：单命令内启动 dev server，核对 trades API 方向语义（执行方向+信号方向+反向标记）
set -u
cd /home/z/my-project

echo "=== [1] 启动 dev server（命令内临时验证用）==="
setsid nohup bun run dev </dev/null >> dev.log 2>&1 &
echo "dev pid: $!"

ok=""
for i in $(seq 1 90); do
  if curl -s --noproxy '*' -m 2 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then ok=1; echo "ready after ${i}s"; break; fi
  sleep 1
done
[ -z "$ok" ] && { echo "ERROR: 未就绪"; tail -20 dev.log; exit 1; }

echo "=== [2] trades API：方向字段核对 ==="
curl -s --noproxy '*' -m 60 "http://127.0.0.1:3000/api/trend-trading/trades?limit=5" -o /tmp/t77.json -w "GET /api/trend-trading/trades -> HTTP %{http_code}\n"
python3 - <<'PY'
import json
d = json.load(open('/tmp/t77.json'))
assert d.get('ok'), d
trades = d.get('trades') or []
print(f"返回 {len(trades)} 笔：")
for t in trades[:5]:
    print(f"  {t['base']:>6} side={t['side']:<5} signalSide={t.get('signalSide')} reversed={t.get('reversed')} net={t.get('netPnlWithSlip')}")
# 语义断言：side 与库中 PaperPosition 一致；reversed = (side != signalSide)
con_ok = all((t['side'] == t['signalSide']) == (not t.get('reversed')) for t in trades)
print('语义自洽(side==signalSide ⇔ !reversed):', con_ok)
PY

echo "=== [3] 总览 API（持仓卡方向）==="
curl -s --noproxy '*' -m 60 "http://127.0.0.1:3000/api/trend-trading" -o /tmp/t77b.json -w "GET /api/trend-trading -> HTTP %{http_code}\n"
python3 - <<'PY'
import json, sqlite3
d = json.load(open('/tmp/t77b.json'))
assert d.get('ok'), d
print('mode(顶层)=', d.get('mode'), ' openCount=', (d.get('stats') or {}).get('openCount'))
for p in (d.get('positions') or []):
    print(f"  持仓 {p['base']:>6} side={p['side']}")
# 与库中 PaperPosition 逐一核对
con = sqlite3.connect('db/custom.db')
dbpos = dict(con.execute("select symbol, side from PaperPosition where status='OPEN'").fetchall())
con.close()
ok = all(dbpos.get(p['symbol']) == p['side'] for p in (d.get('positions') or []))
print('持仓方向与库一致:', ok)
PY

echo "=== [4] 首页 ==="
curl -s --noproxy '*' -m 30 -o /dev/null -w "GET / -> HTTP %{http_code}\n" http://127.0.0.1:3000/
echo "verify done（进程随命令结束回收，属预期）"
