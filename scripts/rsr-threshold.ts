// 复算 RSRUSDT 在北京 11:32 时刻的自适应阈值（与 KlineStore 同口径）
// medAbs1m = 过去 6h 完整 1m K 线收盘-收盘收益率的绝对值中位数
// medAbs5m = 过去 12h 的 5m 对应值
const URL = 'https://api.binance.com/api/v3/klines';
const t0332 = Date.parse('2026-10-13T03:32:00Z');

function median(a: number[]) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function klines(interval: string, start: number, end: number) {
  const res = await fetch(`${URL}?symbol=RSRUSDT&interval=${interval}&startTime=${start}&endTime=${end}&limit=1000`);
  return (await res.json()) as any[];
}

async function main() {
  // 1m: 过去 6h（05:32-11:32 北京 = 21:32-03:32 UTC，取完整K线）
  const m1 = await klines('1m', t0332 - 6 * 3600_000, t0332);
  const rets1: number[] = [];
  for (let i = 1; i < m1.length; i++) {
    const prev = +m1[i - 1][4], cur = +m1[i][4];
    if (prev > 0) rets1.push(Math.abs((cur - prev) / prev) * 100);
  }
  const med1 = median(rets1);

  // 5m: 过去 12h
  const m5 = await klines('5m', t0332 - 12 * 3600_000, t0332);
  const rets5: number[] = [];
  for (let i = 1; i < m5.length; i++) {
    const prev = +m5[i - 1][4], cur = +m5[i][4];
    if (prev > 0) rets5.push(Math.abs((cur - prev) / prev) * 100);
  }
  const med5 = median(rets5);

  console.log(`RSR 北京 11:32 时刻自适应基准（KlineStore 同口径）:`);
  console.log(`  medAbs1m（6h 中位数）= ${med1?.toFixed(3)}%  → thMinor1m = max(1.0, ${(med1 * 3).toFixed(2)}) = ${Math.max(1, med1 * 3).toFixed(2)}%  thMajor1m = max(2.0, ${(med1 * 6).toFixed(2)}) = ${Math.max(2, med1 * 6).toFixed(2)}%`);
  console.log(`  medAbs5m（12h 中位数）= ${med5?.toFixed(3)}%  → thMinor5m = max(2.0, ${(med5 * 3).toFixed(2)}) = ${Math.max(2, med5 * 3).toFixed(2)}%  thMajor5m = max(3.5, ${(med5 * 6).toFixed(2)}) = ${Math.max(3.5, med5 * 6).toFixed(2)}%`);
  console.log(`\n实际异动: 1m +2.21%（MAJOR 阈值需 <2.21 → ${Math.max(2, med1 * 6) < 2.21 ? '命中' : '被压制'}）`);
  console.log(`          5m +2.81%（MINOR 阈值需 <2.81 → ${Math.max(2, med5 * 3) < 2.81 ? '命中' : '被压制'}）`);
  console.log(`\n对照：若 RSR 全天安静 med≈0.1%，则 MAJOR 阈值就是固定值 2.0%，+2.21% 会正常触发`);
}
main().catch(console.error);
