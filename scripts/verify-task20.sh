#!/bin/bash
# Task 20 UI 端到端验证：雷达页涨跌幅榜同栏（机会扫描迁移）+ 模拟盘页精简 + 移动端
set -x
cd /home/z/my-project

# 1) 启动 dev server
pkill -f "next dev" 2>/dev/null
sleep 1
setsid nohup bun run dev > /tmp/dev.log 2>&1 < /dev/null &
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "SERVER READY: $code"
mkdir -p .shots

# 2) 桌面视口
agent-browser set viewport 1440 900
agent-browser open http://localhost:3000
sleep 5

# 3) 切到涨跌幅榜 tab（等待首轮信号扫描完成）
agent-browser find role tab click --name "涨跌幅榜"
sleep 30
agent-browser screenshot .shots/desktop-movers.png
agent-browser eval "(() => {
  const t = document.body.innerText;
  return {
    moversTab: t.includes('涨跌幅榜'),
    signalStrip: t.includes('机会扫描'),
    signalList: t.includes('均线支撑位机会'),
    majorSupport: t.includes('大级别支撑'),
    majorResist: t.includes('大级别压力'),
    buyBtn: t.includes('买入做多'),
    coverage: (t.match(/当前覆盖 \d+ 个/) || [''])[0],
  };
})()"

# 4) 雷达页直接交易：点击信号列表首个「买入做多」→ TradeModal
agent-browser find role button click --name "买入做多"
sleep 2
agent-browser screenshot .shots/desktop-trade-modal.png
agent-browser eval "(() => {
  const t = document.body.innerText;
  const modal = document.querySelector('[role=dialog]');
  return { modalOpen: !!modal, head: modal ? modal.textContent.slice(0, 120) : '' };
})()"
agent-browser press Escape
sleep 1

# 5) 切到模拟盘视图：应只有 MA7 + 异动监控 + 模拟盘
agent-browser find role button click --name "模拟盘 · MA7 异动"
sleep 4
agent-browser screenshot .shots/desktop-scanner.png
agent-browser eval "(() => {
  const t = document.body.innerText;
  return {
    ma7: t.includes('MA(7) 沿线顺势'),
    anomalyMonitor: t.includes('异动监控 · 一键交易'),
    paperPanel: t.includes('总权益') || t.includes('可用余额') || t.includes('权益'),
    signalGone: !t.includes('均线支撑位机会'),
    majorGone: !t.includes('大级别支撑'),
    tradFiCopy: t.includes('TradFi'),
  };
})()"

# 6) 移动端 390x844：雷达页涨跌幅榜
agent-browser set viewport 390 844
agent-browser find role button click --name "雷达"
sleep 2
agent-browser find role tab click --name "涨跌幅榜"
sleep 3
agent-browser screenshot .shots/mobile-movers.png --full

# 7) 移动端模拟盘
agent-browser find role button click --name "模拟"
sleep 3
agent-browser screenshot .shots/mobile-scanner.png --full

# 8) 控制台错误
echo "=== console errors ==="
agent-browser errors
agent-browser console 2>/dev/null | grep -iE "error|warn" | grep -v "Download the React DevTools" | head -10
echo "=== DONE ==="
