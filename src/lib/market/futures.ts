// ---------- 模拟盘 · 币安 USDT-M 合约规则（客户端/服务端同源，防两处公式漂移） ----------
// 重置资金 10 USDT · 最高 20x 杠杆 · 最低保证金 2 USDT · 单仓最高几乎全仓（余额预留手续费后可拉满）
// 手续费：Taker 0.05%（市价开/平仓双边收取）· Maker 0.02%（限价挂单，备案；模拟盘统一按 Taker 计）
// 强平价：币安逐仓精确式 liq = E(1±IMR)/(1∓MMR)，MMR 按名义价值分层（BTC/ETH/其他 各自档位）

export const PAPER_INITIAL_CAPITAL = 10;
export const PAPER_MAX_LEVERAGE = 20;
export const PAPER_MIN_MARGIN = 2;
export const PAPER_MIN_DEPOSIT = 10;
export const PAPER_MAX_DEPOSIT = 1_000_000;

/** 单仓风险上限：单仓保证金最高占可用余额的比例。
 *  Task 48 曾收紧至 0.5（防全仓梭哈），用户反馈过紧——Task 49 放开为 1（几乎全仓：
 *  仅需预留开仓手续费，与初版规则一致）。保留常量与 maxOpenableMargin 封装，
 *  未来再调比例只改这一个数字，前后端与报错文案自动跟随。强平价公式不受此值影响。 */
export const PAPER_MAX_MARGIN_RATIO = 1;

/**
 * 单仓最大可开保证金（客户端/服务端同源）：
 * 取「可用余额 × 比例上限」与「预留开仓手续费后的全额上限」两者较小值，向下取整到分。
 * 比例 = 1 时手续费上限恒为主导，等价于初版几乎全仓口径；< 1 时比例上限主导。
 * 前端 trade-modal 展示「最大可开」与服务端 PaperEngine.open 拒绝阈值由本函数唯一提供。
 */
export function maxOpenableMargin(available: number, leverage: number): number {
  if (!Number.isFinite(available) || available <= 0) return 0;
  const ratioCap = available * PAPER_MAX_MARGIN_RATIO; // 单仓比例上限
  const feeCap = available / (1 + leverage * TAKER_FEE); // 需预留开仓手续费
  // +1e-9 抵消浮点伪影：如 4960.4×0.5 实算 2480.1999999999998，裸 floor 会丢一分钱
  return Math.floor((Math.min(ratioCap, feeCap) + 1e-9) * 100) / 100;
}

/** 币安 USDT-M 合约费率 */
export const TAKER_FEE = 0.0005; // 0.05% 市价单
export const MAKER_FEE = 0.0002; // 0.02% 限价单（备案）

interface MmrTier {
  limit: number; // 名义价值上限（USDT）
  mmr: number; // 维持保证金率
}

// 分层维持保证金率（首档 + 名义越大档位越高），按币安 USDT-M 主流档位近似
const MMR_TIERS: Record<string, MmrTier[]> = {
  BTCUSDT: [
    { limit: 50_000, mmr: 0.004 },
    { limit: 250_000, mmr: 0.005 },
    { limit: 1_000_000, mmr: 0.01 },
    { limit: Infinity, mmr: 0.02 },
  ],
  ETHUSDT: [
    { limit: 10_000, mmr: 0.005 },
    { limit: 100_000, mmr: 0.01 },
    { limit: Infinity, mmr: 0.02 },
  ],
};
// 山寨/其他币对档位：对齐币安 USDT-M 真实水平（小额维持保证金率远低于初始保证金率）。
// ⚠️ Task 47 事故教训：此前第 3/4 档（5%/10%）过高 —— 20x 满杠杆时初始保证金率 IMR=0.05
// 与 MMR=0.05 相撞，逐仓强平价公式退化到开仓价（ICP 空单开仓 1 秒即被误强平，见 worklog Task 47）
const DEFAULT_TIERS: MmrTier[] = [
  { limit: 5_000, mmr: 0.005 },
  { limit: 25_000, mmr: 0.01 },
  { limit: 100_000, mmr: 0.025 },
  { limit: Infinity, mmr: 0.05 },
];

/** 按名义价值取维持保证金率 */
export function mmrFor(symbol: string, notional: number): number {
  const tiers = MMR_TIERS[symbol.toUpperCase()] ?? DEFAULT_TIERS;
  for (const t of tiers) if (notional <= t.limit) return t.mmr;
  return tiers[tiers.length - 1].mmr;
}

/**
 * 币安逐仓强平价（精确式，含维持保证金计提）——⚠️ Task 48 后此公式冻结不动，
 * 仓位风险控制改由 maxOpenableMargin（单仓保证金上限）承担：
 * 多：liq = E × (1 − 1/L) / (1 − MMR)；空：liq = E × (1 + 1/L) / (1 + MMR)
 * 抽查：BTC 20x 多 −4.62% / 空 +4.58%；山寨 20x 多 −4.04%
 *
 * ⚠️ 退化防御（Task 47 修复）：当 MMR ≥ IMR（初始保证金率）时公式数学退化——
 * IMR=MMR 时强平价 = 开仓价（开仓即触发强平）；IMR<MMR 时空单强平价低于开仓价 /
 * 多单高于开仓价（开仓瞬间必然命中）。真实交易所通过限制大名义标的的最大杠杆保证
 * IMR > MMR，模拟盘以「MMR ≤ IMR/2」钳制近似同一约束，确保强平价距开仓价
 * 至少半个初始保证金率（20x ≥2.5%、10x ≥5%、5x ≥10%）。
 */
export function liqPriceFor(input: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  leverage: number;
  notional: number; // 名义价值 = 保证金 × 杠杆（用于 MMR 分层）
}): number {
  const { symbol, side, entry, leverage, notional } = input;
  const imr = 1 / leverage;
  const mmr = Math.min(mmrFor(symbol, notional), imr / 2); // 钳制：杜绝强平价退化/反转
  return side === 'LONG' ? (entry * (1 - imr)) / (1 - mmr) : (entry * (1 + imr)) / (1 + mmr);
}
