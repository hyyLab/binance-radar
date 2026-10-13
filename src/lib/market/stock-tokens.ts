// ---------- TradFi 代币化股票 / 非虚拟币识别 ----------
// Binance 代币化股票（xStock）命名规则：股票代码 + B 后缀（如 MSTRB / CRCLB / SNDKB / SOXLB）
// 用途：
//  - 机会扫描 / MA(7) 扫描：剔除股票与商品代币（只聚焦加密货币）
//  - 异动监控：反向识别股票代币 → 纳入 TradFi 异动并打「股」标（门槛单独放宽）
// 独立模块（无内部依赖），供 collector / scanner 同时导入，避免循环依赖

// 真实股票代码 / ETF 表（Binance 以 代码+B 上市）
export const STOCK_TICKERS = new Set([
  'MSTR', 'CRCL', 'HOOD', 'TSLA', 'AAPL', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'MSFT',
  'META', 'COIN', 'PLTR', 'ORCL', 'NFLX', 'AVGO', 'LLY', 'JPM', 'ABNB', 'SBET',
  'DFDV', 'CEP', 'SMLR', 'BTBT', 'SPY', 'QQQ', 'SOXL', 'SPCX', 'SNDK',
]);

// 其它非虚拟币：贵金属商品代币、稳定币（异动与扫描均无意义）
const EXTRA_EXCLUDED_BASES = new Set(['XAUT', 'XAUTB', 'PAXG', 'PAXGB', 'KAU', 'KAUB', 'RLUSD']);

/** 是否为代币化股票 / ETF base（TradFi） */
export function isStockBase(base: string): boolean {
  if (STOCK_TICKERS.has(base)) return true;
  // 股票代币命名规则：股票代码 + B 后缀（MSTRB / CRCLB 等，动态覆盖未来新上市）
  return base.endsWith('B') && STOCK_TICKERS.has(base.slice(0, -1));
}

/** 机会扫描 / MA(7) 扫描是否剔除该 base（代币化股票 + 贵金属商品 + 稳定币） */
export function isExcludedBase(base: string): boolean {
  if (EXTRA_EXCLUDED_BASES.has(base)) return true;
  return isStockBase(base);
}
