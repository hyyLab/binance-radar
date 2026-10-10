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
  hotTags: string[] | null; // 今日热门池入选标签 VOL/UP/DOWN/SURGE
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

export interface HotPoolSummary {
  date: string; // UTC+8 日期
  total: number;
  tags: Record<string, number>; // VOL/UP/DOWN/SURGE 计数
  updatedAt: number;
}

export interface StatsResponse extends MarketStats {
  ok: true;
  anomaliesLast1h: number;
  anomaliesLast24h: number;
  hotPool: HotPoolSummary;
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

// ---------- 机会扫描 ----------

export type { MaSignal, MajorLevel, SymbolLevels } from './indicators';
import type { MaSignal, SymbolLevels } from './indicators';

export interface ScannerStatusDTO {
  scanning: boolean;
  levelScanning: boolean;
  lastSignalScanAt: number;
  lastLevelScanAt: number;
  coverage: number;
  universe: {
    gainers: number; // 涨幅榜入选数
    losers: number; // 跌幅榜入选数
    anomalies: number; // 近 4h 异动入选数
    total: number; // 去重后宇宙总量
    refreshIntervalMin: number; // 榜单全量重建周期（分钟）
    lastRefreshAt: number; // 上次全量重建时间戳
    nextRefreshAt: number; // 下次全量重建时间戳（预估）
  };
}

export interface SignalsResponse {
  ok: true;
  ts: number;
  status: ScannerStatusDTO;
  data: MaSignal[];
}

export interface LevelsResponse {
  ok: true;
  ts: number;
  status: ScannerStatusDTO;
  data: SymbolLevels[];
}

// ---------- 模拟建仓 ----------

export type TradeAction =
  | 'OPEN_LONG'
  | 'OPEN_SHORT'
  | 'CLOSE_LONG'
  | 'CLOSE_SHORT'
  | 'LIQUIDATE';

export interface PaperPositionDTO {
  id: string;
  symbol: string;
  base: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  margin: number;
  qty: number;
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
  notional: number;
  unrealizedPnl: number;
  roePct: number;
  openedAt: string;
}

export interface PaperTradeDTO {
  id: string;
  symbol: string;
  action: TradeAction;
  price: number;
  qty: number;
  fee: number;
  pnl: number;
  createdAt: string;
}

export interface PaperAccountDTO {
  balance: number;
  marginUsed: number;
  unrealizedPnl: number;
  equity: number;
  initialCapital: number;
  realizedPnl: number;
  feePaid: number;
  winRate: number;
  closedCount: number;
  liquidatedCount: number;
  roiPct: number;
}

export interface PaperAccountResponse {
  ok: true;
  ts: number;
  account: PaperAccountDTO;
  positions: PaperPositionDTO[];
  history: PaperTradeDTO[];
}

export interface PaperOpenResponse {
  ok: true;
  position: PaperPositionDTO;
}

export interface PaperCloseResponse {
  ok: true;
  symbol: string;
  side: string;
  price: number;
  pnl: number;
}

export interface PaperTradesResponse {
  ok: true;
  ts: number;
  count: number;
  data: PaperTradeDTO[];
}
