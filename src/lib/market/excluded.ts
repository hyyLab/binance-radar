// ---------- 代币化股票 / 贵金属等非加密原生标的剔除 ----------
// 这些标的走势由外部市场决定（美股时段/金价），加密异动检测意义有限，且常出现开盘跳价假信号。

const EXCLUDED_BASES = new Set([
  // 贵金属
  'PAXG',
  'XAUT',
  // 代币化股票（Binance xStocks 等，后缀 X）
  'AAPLX',
  'TSLAX',
  'NVDAX',
  'MSTRX',
  'COINX',
  'AMZNX',
  'GOOGLX',
  'METAX',
  'MSFTX',
  'HOODX',
  'CRCLX',
  'SPYX',
  'QQQX',
  'OPENX',
  'TLNX',
]);

// 常见美股/ETF 代码 + X 后缀的兜底匹配
const STOCK_TICKERS = new Set([
  'AAPL',
  'TSLA',
  'NVDA',
  'MSFT',
  'AMZN',
  'GOOGL',
  'META',
  'COIN',
  'MSTR',
  'HOOD',
  'CRCL',
  'SPY',
  'QQQ',
  'PLTR',
  'TLN',
  'OPEN',
]);

export function isExcludedBase(base: string): boolean {
  const b = base.toUpperCase();
  if (EXCLUDED_BASES.has(b)) return true;
  if (b.endsWith('X') && STOCK_TICKERS.has(b.slice(0, -1))) return true;
  return false;
}
