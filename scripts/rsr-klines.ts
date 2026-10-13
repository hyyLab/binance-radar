// 拉取 RSRUSDT 03:20-03:45 UTC（北京 11:20-11:45）的 1m K 线，复算各检测器输入
const BK = 'https://api.binance.com';
const FUT = 'https://fapi.binance.com';

async function get1m(host: string, symbol: string) {
  const url = `${host}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${Date.parse('2026-10-13T03:15:00Z')}&endTime=${Date.parse('2026-10-13T03:50:00Z')}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as any[];
}

function bj(ms: number) { return new Date(ms + 8 * 3600_000).toISOString().slice(11, 19); }

async function main() {
  for (const [host, sym] of [[BK, 'RSRUSDT'], [FUT, 'RSRUSDT']] as const) {
    const rows = await get1m(host, sym);
    if (!rows) { console.log(host, 'no data'); continue; }
    console.log(`\n=== ${host} ${sym} 1m K 线（北京 ${bj(rows[0][0])} ~ ${bj(rows[rows.length-1][6])}）===`);
    // 计算每分钟：涨跌幅、成交额(U)，以及对前20根中位数的量比
    let prevClose: number | null = null;
    const qvList: number[] = [];
    const out: string[] = [];
    for (const r of rows) {
      const o = +r[1], c = +r[4], qv = +r[7];
      const chg = prevClose ? ((c - prevClose) / prevClose) * 100 : 0;
      qvList.push(qv);
      // 量比 = 本分钟 qv / 前20根中位数
      const med = (() => {
        const w = qvList.slice(-21, -1).slice();
        if (w.length < 5) return 0;
        w.sort((a,b)=>a-b);
        return w[Math.floor(w.length/2)];
      })();
      const vm = med > 0 ? qv / med : 0;
      out.push(`${bj(r[0])} close=${c.toFixed(5)} chg1m=${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% qv1m=${(qv/1000).toFixed(1)}K volx=${vm ? vm.toFixed(1) : '—'}`);
      prevClose = c;
    }
    console.log(out.join('\n'));
    // 5m 窗口最大涨幅
    let max5 = 0, min5 = 0;
    for (let i = 5; i < rows.length; i++) {
      const c = +rows[i][4], c5 = +rows[i-5][4];
      const chg = ((c - c5) / c5) * 100;
      max5 = Math.max(max5, chg); min5 = Math.min(min5, chg);
    }
    console.log(`窗口内 5m 最大涨 ${max5.toFixed(2)}% / 最大跌 ${min5.toFixed(2)}%`);
  }
}
main().catch(console.error);
