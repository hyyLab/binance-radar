// ---------- MA(7) 沿线趋势 · 逻辑用例（bun scripts/test-ma7.ts） ----------
// 纯函数级验证：analyzeMa7Tf（streak/斜率/偏离/贴线/关键位）+ buildMa7Row（主导方向/相位/评分）

import {
  analyzeMa7Tf,
  buildMa7Row,
  type Ma7Tf,
  type Ma7TfResult,
} from '../src/lib/market/ma7';
import { fmtRideDuration, fmtRideDurationShort } from '../src/lib/ma7-ui';

type Row = [
  number, string, string, string, string, string, number, string, number, string, string, string,
];

const TF_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000,
};

/** 依据收盘价数组造已收盘 K 线（可注入每根 low/high 覆盖） */
function makeKl(
  closes: number[],
  tf: string,
  opts?: { lows?: number[]; highs?: number[]; openLast?: boolean },
): Row[] {
  const step = TF_MS[tf] ?? 60_000;
  const now = Date.now();
  const start = now - closes.length * step - step;
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    const hi = opts?.highs?.[i] ?? Math.max(o, c) * 1.001;
    const lo = opts?.lows?.[i] ?? Math.min(o, c) * 0.999;
    const closeTime = start + i * step + step;
    // openLast：最后一根 closeTime 推到未来（+2 步长，避免与 Date.now() 同刻被误判为已收盘）
    const ct =
      opts?.openLast && i === closes.length - 1 ? closeTime + 2 * step : closeTime;
    return [
      start + i * step,
      String(o),
      String(hi),
      String(lo),
      String(c),
      '1000',
      ct, // closeTime
      '1000',
      10,
      '0',
      '0',
      '0',
    ] as Row;
  });
}

/** 与引擎一致的 SMA7 序列（测试内复算，用于构造贴线 low/high） */
function sma7(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 6; i < closes.length; i++) {
    let s = 0;
    for (let j = i - 6; j <= i; j++) s += closes[j];
    out.push(s / 7);
  }
  return out;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('== analyzeMa7Tf ==');

// 1. 单边上行：连续站上 MA7，无贴线 → 关键位回退为当前 MA7
{
  const closes = Array.from({ length: 26 }, (_, i) => 100 * Math.pow(1.004, i));
  const kl = makeKl(closes, '5m');
  const live = closes[closes.length - 1];
  const r = analyzeMa7Tf('5m', kl, live);
  const mas = sma7(closes);
  const lastMa = mas[mas.length - 1];
  check('上行成线', r?.dir === 'UP', JSON.stringify(r));
  check('streak = 20（窗口内全部）', r?.streak === 20, `streak=${r?.streak}`);
  check('无贴线 → 关键位回退当前 MA7', r != null && Math.abs(r.keyLevel - lastMa) < 1e-6,
    `key=${r?.keyLevel} ma=${lastMa}`);
  check('偏离在 [-0.6, 7] 内', r != null && r.stretchPct > -0.6 && r.stretchPct < 7, `${r?.stretchPct}`);
}

// 2. 上行 + 最近一根影线贴线 → 关键位 = 该 low（支撑）
{
  const closes = Array.from({ length: 26 }, (_, i) => 100 * Math.pow(1.004, i));
  const mas = sma7(closes);
  const lastMa = mas[mas.length - 1];
  const lowsFull = closes.map((c, i) => (i === 25 ? lastMa * 1.002 : c * 0.999));
  const kl = makeKl(closes, '5m', { lows: lowsFull });
  const r = analyzeMa7Tf('5m', kl, closes[25]);
  check('上行贴线 → 支撑 = 最近贴线 low', r != null && Math.abs(r.keyLevel - lowsFull[25]) < 1e-6,
    `key=${r?.keyLevel} expect=${lowsFull[25]}`);
  check('贴线次数 ≥ 1', (r?.touches ?? 0) >= 1);
}

// 3. 单边下行镜像：关键位 = 最近贴线 high（压力）
{
  const closes = Array.from({ length: 26 }, (_, i) => 100 * Math.pow(0.996, i));
  const mas = sma7(closes);
  const lastMa = mas[mas.length - 1];
  const highs = closes.map((c, i) => (i === 25 ? lastMa * 0.998 : c * 1.001));
  const kl = makeKl(closes, '5m', { highs });
  const r = analyzeMa7Tf('5m', kl, closes[25]);
  check('下行成线', r?.dir === 'DOWN', JSON.stringify(r));
  check('下行贴线 → 压力 = 最近贴线 high', r != null && Math.abs(r.keyLevel - highs[25]) < 1e-6,
    `key=${r?.keyLevel}`);
}

// 4. 震荡交替：streak < 4 → 不成线
{
  const closes = Array.from({ length: 26 }, (_, i) => (i % 2 === 0 ? 100 : 101));
  const kl = makeKl(closes, '5m');
  const r = analyzeMa7Tf('5m', kl, 100);
  check('震荡不成线', r === null, JSON.stringify(r));
}

// 5. 现价偏离 > 7% → 不成线（追高过滤）
{
  const closes = Array.from({ length: 26 }, (_, i) => 100 * Math.pow(1.004, i));
  const kl = makeKl(closes, '5m');
  const live = closes[25] * 1.1;
  const r = analyzeMa7Tf('5m', kl, live);
  check('偏离 >7% 过滤', r === null, `stretch=${r?.stretchPct}`);
}

// 6. 现价跌破 MA7 超过 -0.6% → 不成线（趋势疑似破坏）
{
  const closes = Array.from({ length: 26 }, (_, i) => 100 * Math.pow(1.004, i));
  const kl = makeKl(closes, '5m');
  const mas = sma7(closes);
  const live = mas[mas.length - 1] * 0.99; // -1%
  const r = analyzeMa7Tf('5m', kl, live);
  check('跌破 MA7 -1% 过滤', r === null, `stretch=${r?.stretchPct}`);
}

// 7. 未收盘 K 线被忽略（最后一根盘中暴跌不影响 streak）
{
  const closes = Array.from({ length: 27 }, (_, i) => 100 * Math.pow(1.004, i));
  const kl = makeKl(closes, '5m', { openLast: true });
  // 手动把最后一根（未收盘）close 改成腰斩，验证仍按已收盘 26 根计算
  kl[26][4] = String(closes[26] * 0.5);
  const r = analyzeMa7Tf('5m', kl, closes[25]);
  check('进行时 K 线被剔除', r?.dir === 'UP' && r.streak === 20, `streak=${r?.streak} dir=${r?.dir}`);
}

// 8. K 线数量不足 → 不成线
{
  const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
  const kl = makeKl(closes, '5m');
  check('K 线不足返回 null', analyzeMa7Tf('5m', kl, closes[9]) === null);
}

console.log('== buildMa7Row ==');

function res(tf: Ma7Tf, dir: 'UP' | 'DOWN', streak: number, keyLevel: number, touches = 2): Ma7TfResult {
  return { tf, dir, streak, holdRatio: streak / 20, stretchPct: 1.2, slopePct: 0.4, touches, keyLevel };
}

// 9. 多数侧主导 + 主导周期取折算时长最长
{
  const row = buildMa7Row(
    'BTCUSDT', 'BTC',
    { price: 100, change24h: 2.5, quoteVolume24h: 5e8 },
    [res('1m', 'UP', 4, 99.1), res('3m', 'UP', 6, 98.5), res('5m', 'DOWN', 4, 101)],
    1000,
  );
  check('多数侧 = UP', row?.dir === 'UP');
  check('aligned = 2', row?.aligned === 2);
  check('主导周期 = 3m（18min > 4min）', row?.leadTf === '3m');
  check('maxRideMin = 18', row?.maxRideMin === 18);
  check('关键位取主导周期', row?.keyLevel === 98.5);
  check('FRESH（≤180min）', row?.phase === 'FRESH');
  check('24h/额透传', row?.change24h === 2.5 && row.quoteVolume24h === 5e8);
}

// 10. 数量并列（2-2）且两侧折算时长最大值并列 → UP（>=）；主导周期取 UP 侧更长者
{
  const row = buildMa7Row(
    'ETHUSDT', 'ETH',
    { price: 10, change24h: -1, quoteVolume24h: 1e7 },
    [
      res('1m', 'UP', 20, 9.9), res('3m', 'UP', 20, 9.8),
      res('5m', 'DOWN', 12, 10.2), res('15m', 'DOWN', 4, 10.4),
    ],
    1000,
  );
  check('2-2 且 sideMax 并列（60=60）→ UP', row?.dir === 'UP', `dir=${row?.dir}`);
  check('UP 侧主导取折算时长最长 → 3m', row?.leadTf === '3m', `lead=${row?.leadTf}`);
  check('并列主导周期取更短：3m(60) vs 1m(20) → 3m', row?.leadTf === '3m');
  check('maxRideMin = 60', row?.maxRideMin === 60, `ride=${row?.maxRideMin}`);
}

// 11. aligned < 2 → 不上榜
{
  const row = buildMa7Row(
    'XUSDT', 'X',
    { price: 1, change24h: 0, quoteVolume24h: 1e6 },
    [res('1m', 'UP', 10, 1), res('3m', 'DOWN', 5, 1.1)],
    1000,
  );
  check('1 Up + 1 Down → aligned=1 不上榜', row === null);
}

// 12. 六周期全线 + MATURE 相位 + label
{
  const row = buildMa7Row(
    'SOLUSDT', 'SOL',
    { price: 200, change24h: 8, quoteVolume24h: 9e8 },
    [
      res('1m', 'UP', 20, 199), res('3m', 'UP', 20, 198), res('5m', 'UP', 20, 197),
      res('15m', 'UP', 20, 195), res('30m', 'UP', 20, 190), res('1h', 'UP', 20, 180),
    ],
    1000,
  );
  check('六周期 aligned = 6', row?.aligned === 6);
  check('MATURE（1200min > 600）', row?.phase === 'MATURE', `phase=${row?.phase}`);
  check('label 含「六周期全线」', (row?.label ?? '').includes('六周期全线'));
  check('主导周期 = 1h', row?.leadTf === '1h');
  check('tfStates 六项齐全', row?.tfStates.length === 6);
}

// 13. EARLY 相位边界（正好 600min）+ 并列主导取更短周期
{
  const row = buildMa7Row(
    'BNBUSDT', 'BNB',
    { price: 600, change24h: 1, quoteVolume24h: 5e8 },
    [res('30m', 'DOWN', 20, 610), res('1h', 'DOWN', 10, 620)],
    1000,
  );
  check('600min → EARLY', row?.phase === 'EARLY', `phase=${row?.phase}`);
  check('并列 600min → 主导取更短周期 30m', row?.leadTf === '30m', `lead=${row?.leadTf}`);
}

console.log('== fmtRideDuration ==');
check('45m', fmtRideDuration(45) === '45 分钟', fmtRideDuration(45));
check('300m → 5.0 小时', fmtRideDuration(300) === '5.0 小时', fmtRideDuration(300));
check('1500m → 1.0 天', fmtRideDuration(1500) === '1.0 天', fmtRideDuration(1500));
check('short 45 → 45m', fmtRideDurationShort(45) === '45m', fmtRideDurationShort(45));
check('short 300 → 5.0h', fmtRideDurationShort(300) === '5.0h', fmtRideDurationShort(300));
check('short 1500 → 1.0d', fmtRideDurationShort(1500) === '1.0d', fmtRideDurationShort(1500));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
