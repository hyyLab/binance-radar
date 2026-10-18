#!/bin/bash
# Task 76 环境回滚恢复验证：单命令内启动 dev server 并完成全量接口验证
set -u
cd /home/z/my-project

echo "=== [1] 启动 dev server（命令内临时验证用）==="
setsid nohup bun run dev </dev/null >> dev.log 2>&1 &
DEV_PID=$!
echo "dev pid: $DEV_PID"

echo "=== [2] 等待 :3000 就绪（最长 90s）==="
ok=""
for i in $(seq 1 90); do
  if curl -s --noproxy '*' -m 2 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; then
    ok=1; echo "ready after ${i}s"; break
  fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "ERROR: dev server 90s 未就绪，dev.log 尾部："
  tail -30 dev.log
  exit 1
fi

echo "=== [3] 首页状态码 ==="
curl -s --noproxy '*' -m 30 -o /dev/null -w "GET / -> HTTP %{http_code}\n" http://127.0.0.1:3000/

echo "=== [4] 趋势交易总览接口 ==="
curl -s --noproxy '*' -m 60 "http://127.0.0.1:3000/api/trend-trading" -o /tmp/tt.json -w "GET /api/trend-trading -> HTTP %{http_code}\n"
python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/tt.json'))
except Exception as e:
    print('JSON 解析失败:', e)
    raise SystemExit(1)
print('ok =', d.get('ok'))
if d.get('ok'):
    cfg = d.get('config') or {}
    print('config.mode       =', cfg.get('mode'))
    print('config.strategyId =', cfg.get('strategyId'))
    print('config.maxPos     =', cfg.get('maxPositions'))
    print('reverseMode       =', cfg.get('reverseMode'))
    pos = d.get('positions') or []
    print('positions(OPEN)   =', len(pos))
    for p in pos[:6]:
        print('  -', p.get('symbol'), p.get('side'), 'pnl=', p.get('unrealizedPnl'))
    print('lastError =', d.get('lastError'))
else:
    print('error =', str(d)[:300])
PY

echo "=== [5] 完成清理（进程将随本命令结束被平台回收，属预期）==="
echo "verify done"
