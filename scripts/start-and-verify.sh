#!/bin/bash
# 启动 dev server（双 fork 孤儿化，逃离调用间进程回收）+ 单次调用内完成全部验证
cd /home/z/my-project
if curl -s -o /dev/null --max-time 2 http://localhost:3000/ 2>/dev/null; then
  echo "[SKIP] server already up"
else
  (setsid bun run dev >/dev/null 2>&1 </dev/null &)
  UP=0
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/ 2>/dev/null)
    if [ "$code" = "200" ]; then echo "[OK] server UP after ${i}s"; UP=1; break; fi
    sleep 1
  done
  if [ "$UP" != "1" ]; then echo "[FAIL] server did not come up"; exit 1; fi
fi

echo "=== 1. tickers（封禁状态 + 股票过滤） ==="
curl -s --max-time 10 http://localhost:3000/api/market/tickers | python3 -c "
import json,sys
d=json.load(sys.stdin)
t=d.get('data') or []
STOCK={'MSTR','CRCL','HOOD','TSLA','AAPL','NVDA','AMZN','GOOGL','GOOG','MSFT','META','COIN','PLTR','ORCL','NFLX','AVGO','LLY','JPM','ABNB','SBET','DFDV','CEP','SMLR','BTBT','SPY','QQQ','SOXL','SPCX','SNDK'}
GOLD={'XAUT','XAUTB','PAXG','PAXGB','KAU','KAUB'}
bad=[x['base'] for x in t if x['base'] in GOLD or x['base'] in STOCK or (x['base'].endswith('B') and x['base'][:-1] in STOCK)]
print('tickers:', d.get('count'), '| 股票/商品残留:', bad if bad else '无 ✓')
if t: print('top3:', [(x['base'], x['price']) for x in t[:3]])
"

echo "=== 2. klines 速度（此前节流队列堵塞 8s+，应 <2s） ==="
for SYM in BTCUSDT POLUSDT; do
  curl -s --max-time 12 "http://localhost:3000/api/market/klines?symbol=$SYM&interval=15m&limit=180" -o /tmp/kl_$SYM.json -w "$SYM: HTTP %{http_code} in %{time_total}s\n"
  python3 -c "
import json
d=json.load(open('/tmp/kl_$SYM.json'))
print('  candles:', len(d.get('data') or []), '| last close:', (d.get('data') or [{}])[-1].get('c'))
" 2>/dev/null
done

echo "=== 3. anomalies（股票/商品过滤） ==="
curl -s --max-time 10 http://localhost:3000/api/market/anomalies | python3 -c "
import json,sys
d=json.load(sys.stdin)
evs=d.get('data') or []
STOCK={'MSTR','CRCL','HOOD','TSLA','AAPL','NVDA','AMZN','GOOGL','GOOG','MSFT','META','COIN','PLTR','ORCL','NFLX','AVGO','LLY','JPM','ABNB','SBET','DFDV','CEP','SMLR','BTBT','SPY','QQQ','SOXL','SPCX','SNDK'}
GOLD={'XAUT','XAUTB','PAXG','PAXGB','KAU','KAUB'}
bad=[e['base'] for e in evs if e['base'] in GOLD or e['base'] in STOCK or (e['base'].endswith('B') and e['base'][:-1] in STOCK)]
print('events:', d.get('count'), '| 股票/商品残留:', bad if bad else '无 ✓')
print('最近5条:', [(e['base'], e['type']) for e in evs[:5]])
"

echo "=== 4. MA7 状态（应为未运行：started 状态里 startedAt=0 或 universe=0） ==="
curl -s --max-time 10 http://localhost:3000/api/scanner/ma7 | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('status') or {}
print('scanning:', s.get('scanning'), '| universe:', s.get('universe'), '| listed:', s.get('listed'), '| startedAt:', s.get('startedAt'))
print('=> M7 扫描器' + ('仍在运行 ✗' if s.get('startedAt') else '未运行 ✓（符合预期）'))
"

echo "=== 5. signals/levels（股票过滤） ==="
curl -s --max-time 10 http://localhost:3000/api/scanner/signals | python3 -c "
import json,sys
d=json.load(sys.stdin)
bad=[s['base'] for s in (d.get('data') or []) if s['base'].endswith('B')]
print('signals:', len(d.get('data') or []), '| 残留:', bad if bad else '无 ✓')
"
curl -s --max-time 10 http://localhost:3000/api/scanner/levels | python3 -c "
import json,sys
d=json.load(sys.stdin)
bad=[l['base'] for l in (d.get('data') or []) if l['base'].endswith('B')]
print('levels:', len(d.get('data') or []), '| 残留:', bad if bad else '无 ✓')
"

echo "=== done ==="
