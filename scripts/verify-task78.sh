#!/bin/bash
# Task 78 验证：db v4 + engine v27 热修复后，运行中服务写路径恢复（lastError 清零且稳定）
set -u
cd /home/z/my-project

probe() {
  curl -s --noproxy '*' -m 30 "http://127.0.0.1:3000/api/trend-trading" -o /tmp/t78.json -w "HTTP %{http_code}" 2>/dev/null
  python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/t78.json'))
except Exception as e:
    print('  [json err]', e); raise SystemExit
sv = d.get('service') or {}
st = d.get('stats') or {}
pos = d.get('positions') or []
print(f"  mode={d.get('mode')} on={sv.get('on')} lastError={'NULL' if sv.get('lastError') is None else str(sv.get('lastError'))[:90]}")
print(f"  openCount={st.get('openCount')} equity={st.get('equity')} positions={[p['base']+':'+p['side'] for p in pos]}")
PY
}

echo "=== [1] 等待 Turbopack 热重载（文件改动已落盘，用户页面轮询会触发重编译）==="
for i in 1 2 3 4 5 6; do
  sleep 10
  code=$(curl -s --noproxy '*' -m 30 -o /tmp/t78.json -w "%{http_code}" "http://127.0.0.1:3000/api/trend-trading" 2>/dev/null)
  err=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/t78.json'))
    print('NULL' if (d.get('service') or {}).get('lastError') is None else 'HAS_ERR')
except: print('PARSE_ERR')
" 2>/dev/null)
  echo "  t+$((i*10))s HTTP=$code lastError=$err"
  if [ "$code" = "200" ] && [ "$err" = "NULL" ]; then break; fi
done

echo "=== [2] 稳定复查（30s 内 3 次抽样，确认写路径持续健康）==="
for i in 1 2 3; do
  sleep 10
  printf "  [%02ds] " $((i*10))
  probe
done
echo "verify done"
