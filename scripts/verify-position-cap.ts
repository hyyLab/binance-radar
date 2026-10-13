// ---------- Task 48 单测：单仓保证金上限（最大可开收紧）+ 强平价公式冻结回归护栏 ----------
// 运行：bunx tsx scripts/verify-position-cap.ts（或 bun run）
// 覆盖：
//   A. maxOpenableMargin 基准值（事故级余额 / 初始资金 / 边界输入）
//   B. 全组合扫描：1~20x × 多档余额 → 比例上限恒成立、手续费预留仍成立、分位取整
//   C. liqPriceFor 回归护栏：Task 47 修复值逐一复算（证明本任务零改动强平价公式）

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

console.log('\n[A] maxOpenableMargin 基准值');
// 事故场景复算：ICP 事故时余额 ~4960.40，旧逻辑最大可开 4911（≈全额），新逻辑砍半
assert(
  '余额 4960.40 @ 20x → 2480.20（50% 砍半，事故级余额）',
  approx(maxOpenableMargin(4960.4, 20), 2480.2),
  `got ${maxOpenableMargin(4960.4, 20)}`,
);
assert(
  '初始资金 10 @ 20x → 5.00',
  approx(maxOpenableMargin(10, 20), 5),
  `got ${maxOpenableMargin(10, 20)}`,
);
assert(
  '杠杆不敏感（比例上限主导）：4960.40 @ 1x 仍 2480.20',
  approx(maxOpenableMargin(4960.4, 1), 2480.2),
  `got ${maxOpenableMargin(4960.4, 1)}`,
);
assert('余额 0 → 0', maxOpenableMargin(0, 20) === 0);
assert('余额负数 → 0', maxOpenableMargin(-5, 10) === 0);
assert('余额 NaN → 0', Number.isNaN(maxOpenableMargin(NaN, 10)) === false && maxOpenableMargin(NaN, 10) === 0);
// 与最低保证金的联动：余额 3 → 上限 1.5 < 最低保证金 2，任何开仓都会被拒（先触发上限或下限其一）
assert(
  '余额 3 @ 20x → 1.50（< 最低保证金 2，全额梭哈通道被关闭）',
  approx(maxOpenableMargin(3, 20), 1.5) && 1.5 < PAPER_MIN_MARGIN,
  `got ${maxOpenableMargin(3, 20)}`,
);

console.log('\n[B] 全组合扫描：1~20x × 多档余额');
const balances = [2, 3, 10, 100, 4960.4, 8958.21, 100_000, 1_000_000];
let scanBad = 0;
for (let lev = 1; lev <= 20; lev++) {
  for (const b of balances) {
    const m = maxOpenableMargin(b, lev);
    // ① 比例上限恒成立
    if (m > b * PAPER_MAX_MARGIN_RATIO + 1e-9) scanBad += 1;
    // ② 手续费预留仍成立（扣款 = 保证金 + 保证金×杠杆×费率 ≤ 余额）
    if (m * (1 + lev * TAKER_FEE) > b + 1e-9) scanBad += 1;
    // ③ 向下取整到分
    if (!Number.isInteger(Math.round(m * 100))) scanBad += 1;
    // ④ 上限不高于旧逻辑（只收紧不放松）
    const legacy = Math.floor((b / (1 + lev * TAKER_FEE)) * 100) / 100;
    if (m > legacy + 1e-9) scanBad += 1;
  }
}
assert(`160 组合（20 杠杆 × 8 余额）全部满足 比例上限/手续费预留/分位取整/只紧不松`, scanBad === 0, `violation ${scanBad} 处`);

// 新上限下的风险敞口：满上仓被强平时最大损失 = 保证金 ≤ 余额一半（不再可能一把打穿）
{
  const b = 4960.4;
  const m = maxOpenableMargin(b, 20);
  assert(
    '满上仓强平最大损失 = 保证金 ≤ 可用余额 50%（强平损失上限减半）',
    m <= b * 0.5 && approx(m, 2480.2),
    `margin ${m}`,
  );
}

console.log('\n[C] liqPriceFor 回归护栏（Task 48 冻结公式，Task 47 修复值不得漂移）');
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
