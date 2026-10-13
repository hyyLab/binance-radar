// Task 47 验证：强平价退化 bug 修复（离线，不依赖 dev server）
// 核心：旧公式在 MMR ≥ IMR 时数学退化/反转 → 一秒强平/开仓即强平；
// 修复后不变量：空单 liq 严格高于开仓价、多单严格低于开仓价，距离 ≥ IMR/2（钳制保证）
import { liqPriceFor, mmrFor, PAPER_MAX_LEVERAGE } from '../src/lib/market/futures';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
}

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('1) 事故复现场景：ICP 20x 空单 名义 99,217U（修复前 liq=3.195=开仓价 → 1秒强平）');
const icpEntry = 3.195;
const icpLiq = liqPriceFor({
  symbol: 'ICPUSDT',
  side: 'SHORT',
  entry: icpEntry,
  leverage: 20,
  notional: 4960.39 * 20,
});
const icpDist = (icpLiq / icpEntry - 1) * 100;
check('强平价 ≠ 开仓价（不再退化）', !near(icpLiq, icpEntry), `liq=${icpLiq.toFixed(6)}`);
check('强平价高于开仓价（空单方向正确）', icpLiq > icpEntry, `+${icpDist.toFixed(2)}%`);
// 钳制保证 MMR ≤ IMR/2 → 距离下界 = (1+IMR)/(1+IMR/2)−1（分母效应略小于 IMR/2）
const shortFloor20x = (1.05 / 1.025 - 1) * 100;
check(`距离 ≥ 精确下界 ${shortFloor20x.toFixed(2)}%（20x 钳制档）`, icpDist >= shortFloor20x - 1e-6, `实际 ${icpDist.toFixed(2)}%`);
check('距离合理（≤2.7%）', icpDist <= 2.7, `MMR=2.5% 档`);

console.log('2) 修复前反转场景：20x 名义 20万U（旧 MMR=10% > IMR=5% → 空单强平价低于开仓价、开仓即强平）');
const bigLiq = liqPriceFor({ symbol: 'XXXUSDT', side: 'SHORT', entry: 1.0, leverage: 20, notional: 200_000 });
check('钳制后空单强平价仍高于开仓价', bigLiq > 1.0, `liq=${bigLiq.toFixed(6)} (+${((bigLiq - 1) * 100).toFixed(2)}%)`);
const bigLiqLong = liqPriceFor({ symbol: 'XXXUSDT', side: 'LONG', entry: 1.0, leverage: 20, notional: 200_000 });
check('钳制后多单强平价仍低于开仓价', bigLiqLong < 1.0, `liq=${bigLiqLong.toFixed(6)} (${((bigLiqLong - 1) * 100).toFixed(2)}%)`);

console.log('3) 全参数扫描不变量：1x~20x × 1千~100万U，空/多强平价方向恒正确、距离 ≥ 钳制精确下界');
let violations = 0;
let worstShort = Infinity;
let worstLong = -Infinity;
for (let lev = 1; lev <= PAPER_MAX_LEVERAGE; lev++) {
  for (const notional of [1_000, 5_000, 25_000, 100_000, 500_000, 1_000_000]) {
    for (const entry of [0.0001, 0.5, 3.195, 100, 95_000]) {
      const imr = 1 / lev;
      const shortFloor = (1 + imr) / (1 + imr / 2) - 1; // 空单距离精确下界
      const longCeil = 1 - (1 - imr) / (1 - imr / 2); // 多单|距离|精确下界（负号）
      const s = liqPriceFor({ symbol: 'XXXUSDT', side: 'SHORT', entry, leverage: lev, notional });
      const l = liqPriceFor({ symbol: 'XXXUSDT', side: 'LONG', entry, leverage: lev, notional });
      const sd = s / entry - 1;
      const ld = l / entry - 1;
      if (sd < shortFloor - 1e-9 || ld > -longCeil + 1e-9) violations++;
      if (s / entry <= 1) violations++; // 空单强平价不得低于等于开仓价
      if (l / entry >= 1) violations++; // 多单强平价不得高于等于开仓价
      worstShort = Math.min(worstShort, sd * 100);
      worstLong = Math.max(worstLong, ld * 100);
    }
  }
}
check('600 组合零违例', violations === 0, `违例 ${violations}`);
check('最差空单距离仍为正', worstShort > 0, `min +${worstShort.toFixed(2)}%`);
check('最差多单距离仍为负', worstLong < 0, `max ${worstLong.toFixed(2)}%`);

console.log('4) MMR 档位校准后的常规抽查（低名义不受钳制影响）');
check(
  'BTC 20x 5万U 档 MMR=0.4% 行为不变',
  near(mmrFor('BTCUSDT', 50_000), 0.004),
  `mmr=${mmrFor('BTCUSDT', 50_000)}`,
);
const btcLiq = liqPriceFor({ symbol: 'BTCUSDT', side: 'LONG', entry: 100_000, leverage: 20, notional: 500_000 });
check(
  'BTC 20x 50万U（MMR=1% 档）多单 = −4.04%（钳制不影响 BTC/ETH 档位）',
  near((btcLiq / 100_000 - 1) * 100, -4.0404, 1e-3),
  `${((btcLiq / 100_000 - 1) * 100).toFixed(2)}%`,
);
const altSmall = liqPriceFor({ symbol: 'YYYUSDT', side: 'SHORT', entry: 1.0, leverage: 20, notional: 3_000 });
check(
  '山寨小额 20x 空 = +4.48%（MMR=0.5% 档，(1+0.05)/(1+0.005)）',
  near((altSmall - 1) * 100, 4.4776, 1e-3),
  `+${((altSmall - 1) * 100).toFixed(2)}%`,
);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
