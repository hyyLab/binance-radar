#!/bin/bash
# 币安热点雷达 keepalive 守护：每 20s 健康检查，掉线自动重启 dev server
cd /home/z/my-project
LOG=/home/z/my-project/.zscripts/keepalive.log
URL=http://localhost:3000/

check() {
  curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null
}

echo "[$(date '+%F %T')] keepalive started (pid $$)" >> "$LOG"

while true; do
  code=$(check)
  if [ "$code" != "200" ]; then
    echo "[$(date '+%F %T')] DOWN (code=$code) -> restarting" >> "$LOG"
    pkill -f "next dev" 2>/dev/null
    pkill -f "next-server" 2>/dev/null
    sleep 1
    setsid nohup bun run dev >> /home/z/my-project/.zscripts/dev.log 2>&1 < /dev/null &
    ok=""
    for i in $(seq 1 45); do
      sleep 2
      c=$(check)
      if [ "$c" = "200" ]; then ok=1; break; fi
    done
    if [ -n "$ok" ]; then
      echo "[$(date '+%F %T')] RECOVERED (code=200)" >> "$LOG"
    else
      echo "[$(date '+%F %T')] RESTART FAILED after 90s (last code=$c)" >> "$LOG"
    fi
  fi
  sleep 20
done
