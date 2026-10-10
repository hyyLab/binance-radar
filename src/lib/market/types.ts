// ---------- 共享类型（服务端 / 客户端均可安全导入） ----------

export type AnomalyType =
  | 'SPIKE_UP' // 短时拉升
  | 'SPIKE_DOWN' // 短时跳水
  | 'VOLUME_SURGE' // 成交量激增
  | 'BREAKOUT_HIGH' // 突破 24h 新高
  | 'BREAKOUT_LOW'; // 跌破 24h 新低

export type AnomalySeverity = 'MINOR' | 'MAJOR';

export interface AnomalyEventDTO {
  id: string;
  symbol: string;
  base: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  price: number;
  changePct: number; // 触发窗口内涨跌幅 %
  volumeMultiple: number; // 量比（成交量异动）
  quoteVolume1m: number; // 触发时 1 分钟成交额（USDT）
  detail: string;
  createdAt: string; // ISO
}

export interface TickerSnapshot {
  symbol: string;
  base: string;
  price: number;
  open: number;
  high24h: number;
  low24h: number;
  change24h: number; // %
  quoteVolume24h: number; // USDT
  chg1m: number | null;
  chg5m: number | null;
  chg15m: number | null;
  chg1h: number | null;
  vol1m: number | null; // 最近 1 分钟成交额
  volMultiple: number | null; // 量比 = vol1m / 过去20分钟均值
  tickDir: 1 | -1 | 0; // 最新成交方向
  updatedAt: number;
}

export interface CoinBrief {
  price: number;
  change24h: number;
}

export interface MarketStats {
  ts: number;
  startedAt: number;
  symbolsTracked: number;
  totalQuoteVolume: number;
  advancing: number;
  declining: number;
  flat: number;
  btc: CoinBrief | null;
  eth: CoinBrief | null;
  lastPriceOk: number;
  last24hOk: number;
  sourceOk: boolean;
  backfilled: boolean;
}

export interface TickersResponse {
  ok: true;
  ts: number;
  count: number;
  data: TickerSnapshot[];
}

export interface AnomaliesResponse {
  ok: true;
  ts: number;
  count: number;
  data: AnomalyEventDTO[];
}

export interface StatsResponse extends MarketStats {
  ok: true;
  anomaliesLast1h: number;
  anomaliesLast24h: number;
}

export interface KlinePoint {
  t: number; // 开盘时间（ms）
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // 基础资产成交量
  qv: number; // 计价资产成交额
}

export interface KlinesResponse {
  ok: true;
  symbol: string;
  interval: string;
  data: KlinePoint[];
}

export interface ApiError {
  ok: false;
  error: string;
}
