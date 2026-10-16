// ---------- 趋势跟踪 · 类型定义 ----------
// 数据流：EnhancedEngine.events() → 候选筛选/评分 → 候选池（去重迟滞）
//        → fetchKlinesFor(1m) → WatchOhlcvSeries → scanAnomalyCandidates()
//        → TrendSignal（阶段/方向/评分）→ 持久化 + /api/enhanced/trends

import type { TrendSignal, TrendState } from 'universal-trend-engine';

/** K 线行（与 FuturesCandle 同形，避免跨层类型耦合） */
export interface TrendCandle {
  t: number; // openTime ms
  o: number;
  h: number;
  l: number;
  c: number;
  qv: number; // 计价成交额 USDT
}

/** 行情快照最小形状（来自 FuturesCollector.getTickers） */
export interface TrendTickerSnap {
  symbol: string;
  price: number;
  quoteVolume24h: number;
  updatedAt: number;
}

/** 候选池条目（内存态） */
export interface TrendPoolEntry {
  symbol: string;
  addedAt: number;
  /** 最近一次「活跃异动续期」时刻（候选过期判定的起点） */
  lastAnomalyAt: number;
  /** 候选过期时间 */
  expiresAt: number;
  /** 最近一次入选理由的候选分（迟滞判定用） */
  lastEntryScore: number;
  /** 最近一次评分未达保留下限的时刻（迟滞宽限起点） */
  lastWeakAt: number;
  /** 最近一轮 K 线刷新时间 */
  lastKlineAt: number;
  /** 最近已参与评估的已收盘 1m bar 开盘时间（同根去重 + 展示） */
  lastBarTime: number | null;
  /** 最近一轮数据缺失（行情过期/K线不足/拉取失败） */
  dataMissing: boolean;
  /** 趋势从 confirmed 回落 idle 的时刻（宽限退出判定用；重启后丢失，按保守处理） */
  confirmedLeftAt: number | null;
}

/** 趋势方向（UTE）映射为中文展示的辅助 */
export type TrendPhase = 'idle' | 'candidate' | 'confirmed';
export type TrendDir = 'up' | 'down' | 'flat';

/** 对外 DTO（/api/enhanced/trends 池行） */
export interface TrendWatchRow {
  symbol: string;
  base: string;
  /** UTE 相位：观察中 idle / 候选趋势 candidate / 已确认趋势 confirmed */
  phase: TrendPhase;
  /** UTE 方向：上行 up / 下行 down / 无明确方向 flat */
  direction: TrendDir;
  /** UTE 趋势评分 0-100（启发式证据分，非概率、非盈利承诺） */
  score: number;
  /** UTE 评估依据（一句话） */
  reason: string;
  /** 证据特征（窗口收益/一致性/量比/突破等，来自 UTE features） */
  features: {
    returnPct: number;
    directionalConsistency: number;
    volumeRatio: number;
    breakout: 'up' | 'down' | 'none';
    rangeExpansion: number;
    barsUsed: number;
    latestBarTime: number;
  } | null;
  /** 连续确认观察数（distinct bars） */
  consecutiveObservations: number;
  /** 相位变化时间（UTE changedAt） */
  changedAt: number | null;
  /** 入池时间 */
  addedAt: number;
  /** 最近一次异动时间（候选依据） */
  lastAnomalyAt: number;
  /** 候选过期时间 */
  expiresAt: number;
  /** 原异动方向（最近一次异动事件方向；无则 null） */
  anomalyDir: 'UP' | 'DOWN' | null;
  /** 原异动等级/优先级（最近一次异动事件） */
  anomalyLevel: 'MINOR' | 'MAJOR' | null;
  anomalyPriority: 'P1' | 'P2' | 'P3' | null;
  /** 事件是否仍活跃 */
  anomalyActive: boolean;
  /** 趋势方向与原异动方向冲突（如异动 UP 但趋势 down）——明确展示，不静默覆盖 */
  conflict: boolean;
  /** 最新收盘 K 线开盘时间 */
  lastBarTime: number | null;
  /** 最近 K 线刷新时间 */
  lastKlineAt: number;
  /** 最新收盘 bar 是否过期（KLINE_STALE_MS） */
  stale: boolean;
  /** 数据缺失标记（行情延迟/K线不足/拉取失败） */
  dataMissing: boolean;
  /** 当前供价（用于展示） */
  price: number | null;
  /** 24h 成交额 */
  quoteVolume24h: number | null;
}

export interface TrendWatchStats {
  poolSize: number;
  maxPoolSize: number;
  confirmed: number;
  candidate: number;
  watching: number;
  klineReqs: number;
  dbWrites: number;
  dbErrors: number;
  lastScanAt: number;
  lastRebuildAt: number;
  startedAt: number;
  restoredFromDb: number;
}

export interface TrendWatchSnapshot {
  ts: number;
  interval: string;
  market: string;
  pool: TrendWatchRow[];
  stats: TrendWatchStats;
}

/** 持久化行（repo 读写形状；status: WATCHING | RETIRED） */
export interface TrendWatchRecord {
  symbol: string;
  market: string;
  interval: string;
  status: 'WATCHING' | 'RETIRED';
  addedAt: number;
  lastAnomalyAt: number | null;
  expiresAt: number | null;
  trendStateJson: string;
  lastSignalJson: string | null;
  lastPhase: TrendPhase;
  lastDirection: TrendDir;
  lastScore: number;
  lastBarTime: number | null;
  lastKlineAt: number | null;
}

/** 持久化接口（生产用 Prisma repo；测试用内存实现） */
export interface TrendWatchRepo {
  loadActive(): Promise<TrendWatchRecord[]>;
  upsert(record: TrendWatchRecord): Promise<void>;
  markRetired(symbol: string, market: string, interval: string): Promise<void>;
}

/** 服务依赖（生产绑定 engine/collector/prisma；测试注入 fake） */
export interface TrendWatchDeps {
  /** 拉取 1m 合约 K 线（按归属源分片） */
  fetchKlines(symbol: string, limit: number): Promise<TrendCandle[]>;
  /** 当前合约行情快照 */
  getTickers(): TrendTickerSnap[];
  /** 异动事件（活跃 + 已结束） */
  getEvents(now: number): {
    active: EnhancedEventLike[];
    ended: EnhancedEventLike[];
  };
  /** 持久化 */
  repo: TrendWatchRepo;
}

/** 服务所需的异动事件最小形状（EnhancedEventDTO 的子集，测试可构造） */
export interface EnhancedEventLike {
  id: string;
  symbol: string;
  dir: 'UP' | 'DOWN';
  state: 'ACTIVE' | 'ENDED';
  level: 'MINOR' | 'MAJOR';
  priority: 'P1' | 'P2' | 'P3';
  evidence: { kind: string; at: number; magnitude: number; detail: string }[];
  breakout: { status: 'NONE' | 'PENDING' | 'CONFIRMED' | 'FALSE' | 'REVIEW' };
  volumeMultiple: number | null;
  firstAt: number;
  updatedAt: number;
  lastPrice: number;
}

/** UTE 信号在服务内的暂存（含 assessment，展示与持久化共用） */
export type StoredSignal = TrendSignal;
export type StoredState = TrendState;
