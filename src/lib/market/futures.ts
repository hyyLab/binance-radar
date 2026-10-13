// ---------- 模拟盘 · 币安 USDT-M 合约规则（客户端/服务端同源，防两处公式漂移） ----------
// 重置资金 10 USDT · 最高 20x 杠杆 · 最低保证金 2 USDT
// 手续费：Taker 0.05%（市价开/平仓双边收取）· Maker 0.02%（限价挂单，备案；模拟盘统一按 Taker 计）
// 强平价：币安逐仓精确式 liq = E(1±IMR)/(1∓MMR)，MMR 按名义价值分层（BTC/ETH/其他 各自档位）

export const PAPER_INITIAL_CAPITAL = 10;
export const PAPER_MAX_LEVERAGE = 20;
export const PAPER_MIN_MARGIN = 2;
export const PAPER_MIN_DEPOSIT = 10;
export const PAPER_MAX_DEPOSIT = 1_000_000;

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
const DEFAULT_TIERS: MmrTier[] = [
  { limit: 5_000, mmr: 0.01 },
  { limit: 25_000, mmr: 0.025 },
  { limit: 100_000, mmr: 0.05 },
  { limit: Infinity, mmr: 0.1 },
];

/** 按名义价值取维持保证金率 */
export function mmrFor(symbol: string, notional: number): number {
  const tiers = MMR_TIERS[symbol.toUpperCase()] ?? DEFAULT_TIERS;
  for (const t of tiers) if (notional <= t.limit) return t.mmr;
  return tiers[tiers.length - 1].mmr;
}

/**
 * 币安逐仓强平价（精确式，含维持保证金计提）：
 * 多：liq = E × (1 − 1/L) / (1 − MMR)；空：liq = E × (1 + 1/L) / (1 + MMR)
 * 抽查：BTC 20x 多 −4.62% / 空 +4.58%；山寨 20x 多 −4.04%
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
  const mmr = mmrFor(symbol, notional);
  return side === 'LONG' ? (entry * (1 - imr)) / (1 - mmr) : (entry * (1 + imr)) / (1 + mmr);
}
