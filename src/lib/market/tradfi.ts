// ---------- TradFi 代币化资产识别（股票 / ETF / 贵金属商品） ----------
// 独立模块：collector（异动监控，含股票）与 scanner/ma7（机会扫描，排除股票）
// 都需要股票代币识别能力，放这里避免循环依赖。
//
// 背景：异动监控要覆盖股票代币（用户需求），但股票代币流动性远低于加密币
// （24h 成交额 0.4 万 ~ 800 万 USDT，1 分钟成交额通常 0 ~ 5 千），
// collector 按此做门槛分流；机会扫描 / M(7) 扫描仍排除它们（资金效率低且易被操纵）。

// 代币化股票 / ETF：真实股票代码表（Binance 命名为 代码+B，如 MSTRB / CRCLB / SNDKB / SOXLB）
export const STOCK_TICKERS = new Set([
  'MSTR', 'CRCL', 'HOOD', 'TSLA', 'AAPL', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'MSFT',
  'META', 'COIN', 'PLTR', 'ORCL', 'NFLX', 'AVGO', 'LLY', 'JPM', 'ABNB', 'SBET',
  'DFDV', 'CEP', 'SMLR', 'BTBT', 'SPY', 'QQQ', 'SOXL', 'SPCX', 'SNDK',
]);

// 其它非虚拟币：贵金属商品代币、稳定币（仅机会扫描排除，异动监控不排除 XAUT/PAXG）
const EXTRA_EXCLUDED_BASES = new Set(['XAUT', 'XAUTB', 'PAXG', 'PAXGB', 'KAU', 'KAUB', 'RLUSD']);

/** 是否代币化股票 / ETF（如 MSTRB、TSLAB；Binance 命名规则 = 股票代码 + B 后缀） */
export function isStockBase(base: string): boolean {
  if (STOCK_TICKERS.has(base)) return true;
  if (base.endsWith('B') && STOCK_TICKERS.has(base.slice(0, -1))) return true;
  return false;
}

/** 机会扫描 / M(7) 扫描是否排除该资产（股票 + 贵金属商品代币） */
export function isExcludedBase(base: string): boolean {
  if (EXTRA_EXCLUDED_BASES.has(base)) return true;
  return isStockBase(base);
}
