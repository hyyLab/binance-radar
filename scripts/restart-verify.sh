#!/bin/bash
# 重启 dev server 并在单次调用内完成验证（沙箱会在调用间隙回收进程）
cd /home/z/my-project
pkill -f "next dev" 2>/dev/null; pkill -f "bun run dev" 2>/dev/null; sleep 1
setsid nohup bun run dev > /dev/null 2>&1 &
UP=0
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/ 2>/dev/null)
  if [ "$code" = "200" ]; then echo "[OK] server UP after ${i}s"; UP=1; break; fi
  sleep 1
done
if [ "$UP" != "1" ]; then echo "[FAIL] server did not come up"; exit 1; fi

echo "=== 1. page HTTP ==="
curl -s -o /dev/null -w "/ -> %{http_code}\n" --max-time 8 http://localhost:3000/

echo "=== 2. stats binanceBlock ==="
curl -s --max-time 8 http://localhost:3000/api/market/stats | python3 -c "
import json,sys
d=json.load(sys.stdin)
b=d.get('binanceBlock') or {}
print('blocked:', b.get('blocked'), '| retryInSec:', b.get('retryInSec'), '| reason:', b.get('reason'))
print('sourceOk:', d.get('sourceOk'), '| symbolsTracked:', d.get('symbolsTracked'), '| lastPriceOk:', d.get('lastPriceOk'))
"

echo "=== 3. klines blocked-friendly response ==="
curl -s -w "\nHTTP %{http_code}\n" --max-time 10 "http://localhost:3000/api/market/klines?symbol=BTCUSDT&interval=15m&limit=30" | head -c 300

echo "=== 4. tickers count ==="
curl -s --max-time 8 http://localhost:3000/api/market/tickers | python3 -c "import json,sys; d=json.load(sys.stdin); print('tickers:', d.get('count'))"

echo "=== 5. ma7 ==="
curl -s --max-time 8 http://localhost:3000/api/scanner/ma7 | python3 -c "import json,sys; d=json.load(sys.stdin); s=d.get('status') or {}; print('listed:', s.get('listed'), '| universe:', s.get('universe'), '| lastError:', s.get('lastError')[:80])"

echo "=== done ==="
