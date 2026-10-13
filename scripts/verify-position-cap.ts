// ---------- Task 49 单测：单仓上限放开回「几乎全仓」（比例 1.0）+ 强平价公式冻结回归护栏 ----------
// 运行：bunx tsx scripts/verify-position-cap.ts
// 覆盖：
//   A. maxOpenableMargin 基准值（比例=1 时与初版几乎全仓口径一致：余额预留手续费后可拉满）
//   B. 全组合扫描：1~20x × 多档余额 → 与初版公式逐分一致、手续费预留恒成立、分位取整
//   C. liqPriceFor 回归护栏：Task 47 修复值逐一复算（证明 Task 48/49 两次改动均零触碰强平价公式）

import {
  PAPER_MAX_MARGIN_RATIO,
  PAPER_MIN_MARGIN,
  TAKER_FEE,
  liqPriceFor,
  maxOpenableMargin,
} from '../src/lib/market/futures';

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

console.log('\n[A] maxOpenableMargin 基准值（比例 = 1，几乎全仓）');
assert('比例常量已放开为 1', PAPER_MAX_MARGIN_RATIO === 1, `got ${PAPER_MAX_MARGIN_RATIO}`);
// 初版口径锚点：余额 / (1 + 杠杆×费率) 向下取整到分
assert(
  '初始资金 10 @ 20x → 9.90（几乎全仓拉满，仅预留手续费）',
  approx(maxOpenableMargin(10, 20), 9.9),
  `got ${maxOpenableMargin(10, 20)}`,
);
assert(
  '事故级余额 4960.40 @ 20x → 4911.28（Task 48 的 2480.20 上限已放开）',
  approx(maxOpenableMargin(4960.4, 20), 4911.28),
  `got ${maxOpenableMargin(4960.4, 20)}`,
);
assert(
  '杠杆敏感（手续费主导）：4960.40 @ 1x → 4957.92',
  approx(maxOpenableMargin(4960.4, 1), 4957.92),
  `got ${maxOpenableMargin(4960.4, 1)}`,
);
assert('余额 0 → 0', maxOpenableMargin(0, 20) === 0);
assert('余额负数 → 0', maxOpenableMargin(-5, 10) === 0);
assert('余额 NaN → 0', Number.isNaN(maxOpenableMargin(NaN, 10)) === false && maxOpenableMargin(NaN, 10) === 0);
assert(
  '余额 3 @ 20x → 2.97（≥ 最低保证金 2，小额也能开）',
  approx(maxOpenableMargin(3, 20), 2.97) && 2.97 >= PAPER_MIN_MARGIN,
  `got ${maxOpenableMargin(3, 20)}`,
);

console.log('\n[B] 全组合扫描：1~20x × 多档余额');
const balances = [2, 3, 10, 100, 4960.4, 8958.21, 100_000, 1_000_000];
let scanBad = 0;
for (let lev = 1; lev <= 20; lev++) {
  for (const b of balances) {
    const m = maxOpenableMargin(b, lev);
    // ① 与初版几乎全仓公式逐分一致（比例=1 时 min() 中手续费上限恒主导）
    const legacy = Math.floor((b / (1 + lev * TAKER_FEE)) * 100) / 100;
    if (!approx(m, legacy, 1e-9)) scanBad += 1;
    // ② 手续费预留恒成立（扣款 = 保证金 + 保证金×杠杆×费率 ≤ 余额，满上也不透支）
    if (m * (1 + lev * TAKER_FEE) > b + 1e-9) scanBad += 1;
    // ③ 向下取整到分
    if (!Number.isInteger(Math.round(m * 100))) scanBad += 1;
    // ④ 不高于余额本身（比例上限的平凡形式）
    if (m > b + 1e-9) scanBad += 1;
  }
}
assert(
  '160 组合（20 杠杆 × 8 余额）与初版公式逐分一致 + 手续费预留 + 分位取整',
  scanBad === 0,
  `violation ${scanBad} 处`,
);

// 真·拉满验证：满上仓扣款精确贴住余额（初版「最大」档行为）
{
  const b = 10;
  const m = maxOpenableMargin(b, 20);
  const deduction = m * (1 + 20 * TAKER_FEE);
  assert(
    '满上仓扣款 = 9.90×1.01 = 9.999 ≤ 余额 10（预留手续费后真·拉满）',
    approx(m, 9.9) && deduction <= b && deduction > b - 0.01,
    `margin ${m}, deduction ${deduction}`,
  );
}

console.log('\n[C] liqPriceFor 回归护栏（Task 47 定稿值，Task 48/49 均不得漂移）');
// ICP 事故参数：入场 3.195、20x、名义 99207.8（山寨档第 3 档 MMR 0.025，钳制后同为 0.025）
{
  const shortLiq = liqPriceFor({ symbol: 'ICPUSDT', side: 'SHORT', entry: 3.195, leverage: 20, notional: 4960.39 * 20 });
  const longLiq = liqPriceFor({ symbol: 'ICPUSDT', side: 'LONG', entry: 3.195, leverage: 20, notional: 4960.39 * 20 });
  assert(
    'ICP 20x 空（名义 9.9 万U）强平价 3.272927（+2.44%，Task 47 定稿值）',
    approx(shortLiq, (3.195 * 1.05) / 1.025, 1e-6) && approx(shortLiq, 3.272927, 1e-4),
    `got ${shortLiq}`,
  );
  assert(
    'ICP 20x 多（名义 9.9 万U）强平价 3.115385（−2.50%，方向恒正确）',
    approx(longLiq, (3.195 * 0.95) / 0.975, 1e-6),
    `got ${longLiq}`,
  );
  const btcLiq = liqPriceFor({ symbol: 'BTCUSDT', side: 'LONG', entry: 100, leverage: 20, notional: 40_000 });
  assert(
    'BTC 20x 多（首档 MMR 0.004 不受钳制）强平价 95.382153（−4.62%）',
    approx(btcLiq, (100 * 0.95) / 0.996, 1e-6),
    `got ${btcLiq}`,
  );
  // 高名义仍受钳制保护：山寨 500 万U 名义（末档 MMR 0.05 > IMR/2=0.025 → 钳到 0.025）
  const hugeShort = liqPriceFor({ symbol: 'XXXUSDT', side: 'SHORT', entry: 1, leverage: 20, notional: 5_000_000 });
  assert(
    '山寨 500 万U 名义 20x 空：MMR 钳制生效，强平价 = 1.05/1.025 = 1.024390（距开仓价 ≥ IMR/2）',
    approx(hugeShort, 1.05 / 1.025, 1e-9),
    `got ${hugeShort}`,
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
