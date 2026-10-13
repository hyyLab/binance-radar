// ---------- 升级版异动交易 · 类型定义 ----------

export type LiquidityTier = 'HIGH' | 'MID' | 'LOW' | 'NONE';

export type EvidenceKind =
  | 'SPIKE_UP'
  | 'SPIKE_DOWN'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
  | 'BREAKOUT_UP_PENDING'
  | 'BREAKOUT_DOWN_PENDING'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'VOLUME_NEUTRAL';

export interface Evidence {
  kind: EvidenceKind;
  at: number;
  magnitude: number;
  detail: string;
}

export type Tendency = 'LONG' | 'SHORT' | 'UNKNOWN';
export type ConfirmLevel = 'MULTI' | 'DOUBLE' | 'SINGLE' | 'PENDING';

export interface DirectionJudgement {
  tendency: Tendency;
  confirm: ConfirmLevel;
  reasons: string[];
  caution?: string; // 风险提示（冲高回落/假突破等）
}

export interface Detection {
  detector: 'SPIKE' | 'BREAKOUT' | 'VOLUME';
  dir: 'UP' | 'DOWN' | 'NEUTRAL';
  level: 'MINOR' | 'MAJOR' | 'PENDING';
  magnitude: number; // SPIKE/突破：百分比；VOLUME：倍数
  price: number;
  detail: string;
  baseline?: number; // 突破基准（24h 前高/前低）
  confirmVia?: 'TICKS' | 'CLOSE';
  windows?: string[]; // SPIKE 命中的窗口（如 ["1m","5m"]）
  adaptiveUsed?: boolean;
  quoteVolume1m?: number;
}

export interface SymStats {
  symbol: string;
  tier: LiquidityTier;
  quoteVolume24h: number;
  medAbs1m: number | null; // 6h 已收盘 1m 收益率绝对值中位数 %
  medAbs5m: number | null; // 12h 5m 收益率绝对值中位数 %
  medQv1m: null;
  dataCoverage: number; // 0~1，1m K 线覆盖度
  tickSize: number;
  tradingOk: boolean;
}

export interface EnhancedStats {
  ts: number;
  startedAt: number;
  engineOn: boolean;
  tracked: number;
  tierCounts: { HIGH: number; MID: number; LOW: number };
  bootBackfillDone: number;
  bootBackfillTotal: number;
  expansionPending: number;
  baselineReady: number;
  activeEvents: number;
  endedEvents: number;
  outboundRequests: number;
  lastRotateAt: number;
  dataAnomalies: number;
}

export type Priority = 'P1' | 'P2' | 'P3';
export type EventState = 'ACTIVE' | 'ENDED';

/** 聚合后的升级版异动事件 */
export interface EnhancedEventDTO {
  id: string; // symbol|dir|waveStart
  symbol: string;
  base: string;
  dir: 'UP' | 'DOWN';
  state: EventState;
  level: 'MINOR' | 'MAJOR';
  priority: Priority;
  /** 历史最高优先级（只升不降；「冷却池」判定用：曾达 P1 且现方向不明） */
  peakPriority: Priority;
  /** 最近一次进入 P1 的时刻（§十 P1 时间语义：P1/冷却/已结束池的展示时间以「进入P1」起算，
   *  而非事件首次触发时间；回落后再升级会刷新；从未达 P1 则缺省，展示层回退 firstAt） */
  p1At?: number;
  /** 是否应提醒（升级/新证据/方向变化才置 true；UI 用作高亮） */
  notify: boolean;
  firstAt: number;
  updatedAt: number;
  price: number; // 触发时价格
  lastPrice: number;
  highDuringEvent: number;
  lowDuringEvent: number;
  chg1m: number | null;
  chg5m: number | null;
  volumeMultiple: number | null; // 最新放量倍数
  quoteVolume1m: number | null;
  breakout: {
    status: 'NONE' | 'PENDING' | 'CONFIRMED' | 'FALSE' | 'REVIEW';
    baseline: number | null; // 前高或前低
    beyondPct: number | null; // 相对基准超越幅度 %
    via: 'TICKS' | 'CLOSE' | null;
  };
  evidence: Evidence[];
  direction: DirectionJudgement;
  /** 通知文案（规格书 §十一 格式） */
  headline: string; // [MAJOR][P1] ABCUSDT 上行异动
  lines: string[]; // 明细行
}

/** 检测日志（回放与校准用，环形缓冲） */
export interface DetectionLogEntry {
  t: number;
  symbol: string;
  price: number;
  chg1m: number | null;
  chg5m: number | null;
  qv1m: number | null;
  qv24h: number;
  fixedThreshold: string; // 触发的固定阈值（如 "1m>=1.0"）
  adaptiveThreshold: string; // 自适应阈值（如 "1m>=1.35 (med 0.22%×3)"）
  decision: string;
  reason: string;
}
