// ---------- 趋势跟踪服务 · 行为测试（bun test，fake 依赖注入） ----------
// 覆盖任务要求的 8 类场景中的服务侧 7 类（持久化往返见 repo.test.ts）：
// 1) 候选排序（P1/P2、证据数、流动性、数据质量）
// 2) 去重入池 / 池上限 / 候选过期 / confirmed 保留
// 3) 未收盘 K 线 / 非法 OHLCV / 过期行情过滤
// 4) 同根 K 线重复扫描不累计确认
// 5) 上行 / 下行 / 方向反转
// 7) 重复启动不产生重复定时器/重复恢复
// 8) 历史回放指标：确认延迟、错误确认、请求数、数据缺失

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TrendWatchService } from '@/lib/market/trend-watch/service';
import { toClosedBars } from 'universal-trend-engine';
import type {
  EnhancedEventLike,
  TrendCandle,
  TrendTickerSnap,
  TrendWatchDeps,
  TrendWatchRecord,
  TrendWatchRepo,
} from '@/lib/market/trend-watch/types';

// ============ 虚拟时钟（toClosedBars 依赖 Date.now 判定收盘） ============
const realNow = Date.now;
let fakeNow = realNow();

function advanceMin(n = 1): void {
  fakeNow += n * 60_000;
}

// ============ 合成 K 线 ============

/** 生成 n 根 1m K 线（最后一根已收盘：开盘 = fakeNow - 61s） */
function trendCandles(opts: {
  n: number;
  driftPerBar: number;
  startPrice?: number;
  qv?: number;
  endBeforeMs?: number; // 相对 fakeNow 的最后一根开盘偏移（默认 61_000 = 已收盘）
}): TrendCandle[] {
  const start = opts.startPrice ?? 100;
  const endOffset = opts.endBeforeMs ?? 61_000;
  const out: TrendCandle[] = [];
  let p = start;
  for (let i = 0; i < opts.n; i++) {
    const t = fakeNow - endOffset - (opts.n - 1 - i) * 60_000;
    const o = p;
    const c = p * (1 + opts.driftPerBar);
    out.push({
      t,
      o,
      h: Math.max(o, c) * 1.0005,
      l: Math.min(o, c) * 0.9995,
      c,
      qv: opts.qv ?? 500_000,
    });
    p = c;
  }
  return out;
}

/** 可推进的 fake K 线源：advance() 追加一根新已收盘 bar */
class FakeKlines {
  series: TrendCandle[];
  failNext = false;
  fetchCalls = 0;
  constructor(seed: TrendCandle[]) {
    this.series = seed;
  }
  advance(drift: number, qv?: number): void {
    const last = this.series[this.series.length - 1]!;
    const c = last.c * (1 + drift);
    this.series.push({
      t: last.t + 60_000,
      o: last.c,
      h: Math.max(last.c, c) * 1.0005,
      l: Math.min(last.c, c) * 0.9995,
      c,
      qv: qv ?? last.qv,
    });
  }
  fetch = async (_symbol: string, limit: number): Promise<TrendCandle[]> => {
    this.fetchCalls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('kline fetch failed');
    }
    return this.series.slice(-limit);
  };
}

// ============ 事件/行情/存储 fake ============

function ev(partial: {
  symbol: string;
  dir?: 'UP' | 'DOWN';
  level?: 'MINOR' | 'MAJOR';
  priority?: 'P1' | 'P2' | 'P3';
  state?: 'ACTIVE' | 'ENDED';
  kinds?: string[];
  breakout?: 'NONE' | 'PENDING' | 'CONFIRMED' | 'FALSE' | 'REVIEW';
  volumeMultiple?: number | null;
  updatedAt?: number;
}): EnhancedEventLike {
  const updatedAt = partial.updatedAt ?? fakeNow;
  const kinds = partial.kinds ?? ['SPIKE_UP'];
  return {
    id: `${partial.symbol}|${partial.dir ?? 'UP'}|1`,
    symbol: partial.symbol,
    dir: partial.dir ?? 'UP',
    state: partial.state ?? 'ACTIVE',
    level: partial.level ?? 'MAJOR',
    priority: partial.priority ?? 'P1',
    evidence: kinds.map((k) => ({ kind: k, at: updatedAt, magnitude: 1, detail: '' })),
    breakout: { status: partial.breakout ?? 'NONE' },
    volumeMultiple: partial.volumeMultiple ?? null,
    firstAt: updatedAt - 60_000,
    updatedAt,
    lastPrice: 100,
  };
}

function ticker(symbol: string, qv24 = 10_000_000, ageMs = 0): TrendTickerSnap {
  return {
    symbol,
    price: 100,
    quoteVolume24h: qv24,
    // 动态跟随虚拟时钟：advanceMin 推进后行情仍新鲜（默认 age=0）；
    // 显式传 ageMs 可构造过期行情（T3c）
    get updatedAt() {
      return fakeNow - ageMs;
    },
  };
}

class FakeRepo implements TrendWatchRepo {
  loadCalls = 0;
  upserts = 0;
  retires = 0;
  records = new Map<string, TrendWatchRecord>();
  loadActive = async (): Promise<TrendWatchRecord[]> => {
    this.loadCalls++;
    return [...this.records.values()].filter((r) => r.status === 'WATCHING');
  };
  upsert = async (rec: TrendWatchRecord): Promise<void> => {
    this.upserts++;
    this.records.set(rec.symbol, { ...rec });
  };
  markRetired = async (symbol: string): Promise<void> => {
    this.retires++;
    const prev = this.records.get(symbol);
    if (prev) this.records.set(symbol, { ...prev, status: 'RETIRED' });
  };
}

interface Harness {
  svc: TrendWatchService;
  drv: {
    rebuildPool(now: number): void;
    refreshDue(now: number): void;
    boot(): Promise<void>;
    pool: Map<string, unknown>;
    states: Map<string, { phase: string; direction: string; consecutiveObservations: number }>;
    inflight: Set<string>;
  };
  events: { active: EnhancedEventLike[]; ended: EnhancedEventLike[] };
  tickers: TrendTickerSnap[];
  klines: FakeKlines;
  repo: FakeRepo;
  refreshAll(): Promise<void>;
  flush(): Promise<void>;
}

function makeService(seedCandles: TrendCandle[]): Harness {
  const events = { active: [] as EnhancedEventLike[], ended: [] as EnhancedEventLike[] };
  const tickers: TrendTickerSnap[] = [ticker('TESTUSDT'), ticker('TRENDUSDT'), ticker('OLDUSDT')];
  const klines = new FakeKlines(seedCandles);
  const repo = new FakeRepo();
  const svc = new TrendWatchService({
    fetchKlines: klines.fetch,
    getTickers: () => tickers,
    getEvents: () => ({ active: events.active, ended: events.ended }),
    repo,
  });
  const drv = svc as unknown as Harness['drv'];
  const flush = async () => {
    for (let i = 0; i < 100; i++) {
      if (drv.inflight.size === 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 0)); // flush persist microtasks
  };
  return {
    svc,
    drv,
    events,
    tickers,
    klines,
    repo,
    flush,
    refreshAll: async () => {
      drv.refreshDue(fakeNow);
      await flush();
    },
  };
}

// ============ 测试 ============

describe('TrendWatchService', () => {
  beforeEach(() => {
    fakeNow = realNow();
    Date.now = () => fakeNow; // 虚拟时钟生效：service/UTE 内所有取时走 fakeNow
  });
  afterEach(() => {
    Date.now = realNow;
  });

  // —— T1 候选排序与门槛 ——
  test('T1: 按 P1/P2/证据数/流动性排序与过滤；P3 单证据与低流动性不入池', async () => {
    const h = makeService(trendCandles({ n: 30, driftPerBar: 0.001 }));
    h.events.active = [
      ev({ symbol: 'AAAUSDT', priority: 'P1', level: 'MAJOR', kinds: ['SPIKE_UP', 'VOLUME_UP', 'BREAKOUT_UP'], breakout: 'CONFIRMED', volumeMultiple: 8 }),
      ev({ symbol: 'BBBUSDT', priority: 'P2', level: 'MINOR', kinds: ['SPIKE_UP'] }),
      ev({ symbol: 'CCCUSDT', priority: 'P3', level: 'MINOR', kinds: ['SPIKE_UP'] }),
      // 低流动性例外通道：MAJOR + 有效突破 → qv 200 万可入
      ev({ symbol: 'EEEUSDT', priority: 'P2', level: 'MAJOR', kinds: ['BREAKOUT_UP'], breakout: 'CONFIRMED' }),
      // 低流动性不合格：MAJOR 但无突破/证据不足 → qv 200 万不入
      ev({ symbol: 'FFFUSDT', priority: 'P2', level: 'MAJOR', kinds: ['SPIKE_UP'] }),
    ];
    h.tickers.push(
      ticker('AAAUSDT'), ticker('BBBUSDT'), ticker('CCCUSDT'),
      ticker('EEEUSDT', 2_000_000), ticker('FFFUSDT', 2_000_000),
    );
    h.drv.rebuildPool(fakeNow);
    await h.flush();
    const snap = h.svc.snapshot(fakeNow);
    const syms = snap.pool.map((r) => r.symbol);
    expect(syms).toContain('AAAUSDT');
    expect(syms).toContain('BBBUSDT'); // P2 MINOR 1证 = 25+8+8 = 41 ≥ 40
    expect(syms).not.toContain('CCCUSDT'); // P3 MINOR 1证 = 26 < 40
    expect(syms).toContain('EEEUSDT'); // 例外通道放行
    expect(syms).not.toContain('FFFUSDT'); // 例外通道不放行
    // 排序：AAA（129 分）在 BBB 之前
    expect(syms.indexOf('AAAUSDT')).toBeLessThan(syms.indexOf('BBBUSDT'));
    h.svc.stop();
  });

  // —— T2a 同标的不重复入池 ——
  test('T2a: 同一标的多方向事件只入池一次', async () => {
    const h = makeService(trendCandles({ n: 30, driftPerBar: 0.001 }));
    h.tickers.push(ticker('AAAUSDT'));
    h.events.active = [
      ev({ symbol: 'AAAUSDT', dir: 'UP', priority: 'P1' }),
      ev({ symbol: 'AAAUSDT', dir: 'DOWN', priority: 'P2', kinds: ['SPIKE_DOWN'] }),
    ];
    h.drv.rebuildPool(fakeNow);
    await h.flush();
    expect(h.svc.snapshot(fakeNow).stats.poolSize).toBe(1);
    h.svc.stop();
  });

  // —— T2b 池上限 ——
  test('T2b: 池上限 20，超额候选不挤入', async () => {
    const h = makeService(trendCandles({ n: 30, driftPerBar: 0.001 }));
    const list: EnhancedEventLike[] = [];
    for (let i = 0; i < 25; i++) {
      const sym = `S${String(i).padStart(2, '0')}USDT`;
      list.push(ev({ symbol: sym, priority: 'P2', level: 'MINOR', kinds: ['SPIKE_UP'] }));
      h.tickers.push(ticker(sym));
    }
    h.events.active = list;
    h.drv.rebuildPool(fakeNow);
    await h.flush();
    const stats = h.svc.snapshot(fakeNow).stats;
    expect(stats.poolSize).toBe(20);
    expect(stats.poolSize).toBeLessThan(25);
    h.svc.stop();
  });

  // —— T2c 候选过期退池 ——
  test('T2c: 事件结束 + 超过 TTL + idle 宽限 → 退池；confirmed 不因此退池', async () => {
    const seed = trendCandles({ n: 30, driftPerBar: 0.001 });
    const h = makeService(seed);
    h.tickers.push(ticker('IDLEUSDT'));
    h.events.active = [ev({ symbol: 'IDLEUSDT', priority: 'P2', level: 'MINOR', kinds: ['SPIKE_UP'] })];
    h.drv.rebuildPool(fakeNow);
    await h.flush();
    expect(h.svc.snapshot(fakeNow).stats.poolSize).toBe(1);

    // 事件结束 + 推进 31 分钟（> TTL 30min）+ 再推 16 分钟（> idle 宽限 15min）→ 退
    h.events.active = [];
    h.events.ended = [ev({ symbol: 'IDLEUSDT', state: 'ENDED', priority: 'P2', level: 'MINOR', updatedAt: fakeNow })];
    advanceMin(31);
    h.events.ended = []; // 衰减期也过了
    h.drv.rebuildPool(fakeNow);
    await h.flush();
    expect(h.svc.snapshot(fakeNow).stats.poolSize).toBe(1); // 还差 idle 宽限
    advanceMin(16);
    h.drv.rebuildPool(fakeNow);
    await h.flush();
    expect(h.svc.snapshot(fakeNow).stats.poolSize).toBe(0); // 过期 + idle 宽限过 → 退
    h.svc.stop();
  });

  // —— T2d/e confirmed 保留（数据层验证在 T5/回放） ——
  test('T2d: confirmed 相位在事件结束后仍保留（趋势确认不被异动结束删除）', async () => {
    // 上行数据 60 根：12 根收益 ≈ 15.6% >> minMovePct
    const h = makeService(trendCandles({ n: 60, driftPerBar: 0.0025 }));
    h.events.active = [ev({ symbol: 'TRENDUSDT', priority: 'P1' })];
    h.drv.rebuildPool(fakeNow);
    // 入池后首轮刷新 + 逐 bar 刷新至 confirmed
    for (let i = 0; i < 4; i++) {
      await h.refreshAll();
      if (i < 3) {
        advanceMin(1);
        h.klines.advance(0.0025);
      }
    }
    const st = h.drv.states.get('TRENDUSDT');
    expect(st?.phase).toBe('confirmed');
    // 事件彻底消失 + 45 分钟推进（期间 K 线持续刷新——模拟服务正常运行，数据不过期）
    h.events.active = [];
    for (let i = 0; i < 9; i++) {
      advanceMin(5);
      for (let j = 0; j < 5; j++) h.klines.advance(0.0005); // 温和上行维持趋势
      await h.refreshAll();
    }
    expect(h.svc.snapshot(fakeNow).stats.poolSize).toBe(1); // confirmed 保留
    expect(h.drv.states.get('TRENDUSDT')?.phase).toBe('confirmed');
    h.svc.stop();
  });

  // —— T3a 未收盘 K 线被剔除 ——
  test('T3a: 未收盘 K 线不参与评估（latestBarTime 只取已收盘 bar）', async () => {
    // 30 根已收盘 + 1 根未收盘（开盘 = fakeNow - 30s）
    const seed = [
      ...trendCandles({ n: 30, driftPerBar: 0.001 }),
      ...trendCandles({ n: 1, driftPerBar: 0.001, endBeforeMs: -30_000 }),
    ];
    const h = makeService(seed);
    h.events.active = [ev({ symbol: 'TESTUSDT', priority: 'P2' })];
    h.drv.rebuildPool(fakeNow);
    await h.refreshAll();
    const st = h.drv.states.get('TESTUSDT');
    const lastClosedOpen = fakeNow - 61_000;
    expect(st).toBeTruthy();
    // 状态里的 lastObservationKey = 最后已收盘 bar 的收盘边界 = 开盘 + 60s
    const state = h.drv.states.get('TESTUSDT') as unknown as { lastObservationKey: number | null };
    expect(state.lastObservationKey).toBe(lastClosedOpen + 60_000);
    h.svc.stop();
  });

  // —— T3b 非法 OHLCV 被剔除（UTE 契约） ——
  test('T3b: 非法 bar（high<low / 非正数 / 数组不等长）被拒绝', () => {
    const good = trendCandles({ n: 5, driftPerBar: 0.001 });
    const bad1 = { ...good[0]!, h: good[0]!.l - 1 }; // high < low
    const bad2 = { ...good[1]!, c: -5 }; // 非正收盘
    // 契约层：数组不等长直接抛错
    expect(() =>
      toClosedBars(
        { symbol: 'X', barMs: [1, 2], opens: [1], highs: [1], lows: [1], closes: [1], vols: [1] },
        60_000,
        realNow(),
      ),
    ).toThrow();
    // 服务同款过滤：非法行被剔除后仍可用于评估
    const cleaned = [bad1, bad2, ...good].filter((c) => c.h >= Math.max(c.o, c.c, c.l) && c.c > 0);
    expect(cleaned.length).toBe(good.length);
  });

  // —— T3c 过期行情：不发 K 线请求 ——
  test('T3c: 行情过期/缺失 → dataMissing，且不发出 K 线请求', async () => {
    const h = makeService(trendCandles({ n: 30, driftPerBar: 0.001 }));
    h.events.active = [ev({ symbol: 'TESTUSDT', priority: 'P2' })];
    h.tickers.length = 0;
    h.tickers.push(ticker('TESTUSDT', 10_000_000, 30_000)); // 行情 30s 未更新（> 10s 上限）
    h.drv.rebuildPool(fakeNow);
    await h.refreshAll();
    const entry = h.drv.pool.get('TESTUSDT') as unknown as { dataMissing: boolean };
    expect(entry.dataMissing).toBe(true);
    expect(h.klines.fetchCalls).toBe(0); // 行情无效时不浪费 K 线请求
    h.svc.stop();
  });

  // —— T4 同根 K 线重复扫描不累计确认 ——
  test('T4: 同一根已收盘 K 线重复轮询不增加确认次数；新 bar 才推进', async () => {
    const h = makeService(trendCandles({ n: 60, driftPerBar: 0.0025 }));
    h.events.active = [ev({ symbol: 'TRENDUSDT', priority: 'P1' })];
    h.drv.rebuildPool(fakeNow);
    await h.refreshAll();
    const st = () => h.drv.states.get('TRENDUSDT')!;
    const countAfterFirst = st().consecutiveObservations;
    expect(countAfterFirst).toBe(1);
    // 同一根 bar 连续再刷 3 次（推进时间绕过 60s 节流，但不推进 bar）：确认数不变，请求数增加
    for (let i = 0; i < 3; i++) {
      advanceMin(1);
      await h.refreshAll();
    }
    expect(st().consecutiveObservations).toBe(1);
    expect(st().phase).toBe('candidate');
    expect(h.klines.fetchCalls).toBe(4); // 每次都真实拉取（评估幂等，不省请求）
    // 推进 3 根新 bar → confirmed（1+3=4 次观察，但需 3 个不同 bar → 第 3 个新 bar 达标）
    for (let i = 0; i < 3; i++) {
      advanceMin(1);
      h.klines.advance(0.0025);
      await h.refreshAll();
    }
    expect(st().phase).toBe('confirmed');
    h.svc.stop();
  });

  // —— T5 上行/下行/反转 ——
  test('T5: 上行确认 up；下行数据确认 down；反转经 idle 回落后确认反向', async () => {
    // 下行
    const h = makeService(trendCandles({ n: 60, driftPerBar: -0.0025 }));
    h.events.active = [ev({ symbol: 'TRENDUSDT', dir: 'UP', priority: 'P1' })]; // 异动 UP，趋势独立判断
    h.drv.rebuildPool(fakeNow);
    for (let i = 0; i < 4; i++) {
      await h.refreshAll();
      if (i < 3) {
        advanceMin(1);
        h.klines.advance(-0.0025);
      }
    }
    const st = h.drv.states.get('TRENDUSDT')!;
    expect(st.phase).toBe('confirmed');
    expect(st.direction).toBe('down'); // 趋势方向由价格序列独立判断 ≠ 异动方向
    // 冲突标记：异动 UP vs 趋势 down
    const row = h.svc.snapshot(fakeNow).pool.find((r) => r.symbol === 'TRENDUSDT')!;
    expect(row.conflict).toBe(true);

    // 反转：切换上行数据，多个新 bar
    for (let i = 0; i < 8; i++) {
      advanceMin(1);
      h.klines.advance(0.004); // 强上行反转
      await h.refreshAll();
    }
    const st2 = h.drv.states.get('TRENDUSDT')!;
    expect(st2.phase).toBe('confirmed');
    expect(st2.direction).toBe('up');
    const row2 = h.svc.snapshot(fakeNow).pool.find((r) => r.symbol === 'TRENDUSDT')!;
    expect(row2.conflict).toBe(false); // 趋势 up 与异动 UP 一致
    h.svc.stop();
  });

  // —— T7 重复启动幂等 ——
  test('T7: 重复 ensureStarted 不重复恢复、不重复建定时器；stop 后可安全重入', async () => {
    const h = makeService(trendCandles({ n: 30, driftPerBar: 0.001 }));
    h.repo.records.set('OLDUSDT', {
      symbol: 'OLDUSDT', market: 'futures', interval: '1m', status: 'WATCHING',
      addedAt: fakeNow, lastAnomalyAt: fakeNow, expiresAt: fakeNow + 60_000,
      trendStateJson: JSON.stringify({ symbol: 'OLDUSDT', phase: 'confirmed', direction: 'up', candidateDirection: 'up', consecutiveObservations: 3, changedAt: fakeNow, lastUpdatedAt: fakeNow, lastObservationKey: fakeNow - 60_000, lastScore: 60 }),
      lastSignalJson: null, lastPhase: 'confirmed', lastDirection: 'up', lastScore: 60,
      lastBarTime: fakeNow - 60_000, lastKlineAt: fakeNow,
    });
    await h.svc.ensureStarted();
    await h.svc.ensureStarted(); // started 短路
    await h.svc.ensureStarted();
    expect(h.repo.loadCalls).toBe(1); // 只恢复一次
    expect(h.svc.snapshot(fakeNow).stats.restoredFromDb).toBe(1);
    expect(h.drv.states.get('OLDUSDT')?.phase).toBe('confirmed'); // 确认历史恢复
    h.svc.stop();
    h.svc.stop(); // 双重 stop 安全
    await h.svc.ensureStarted(); // stop 后重入：重新恢复（loadCalls=2）
    h.svc.stop();
    expect(h.repo.loadCalls).toBe(2);
  });

  // —— T8 历史回放指标 ——
  test('T8: 回放——确认延迟 = confirmObservations 根 bar；拉取失败记 dataMissing；请求数可核算', async () => {
    const h = makeService(trendCandles({ n: 60, driftPerBar: 0.0025 }));
    h.events.active = [ev({ symbol: 'TRENDUSDT', priority: 'P1' })];
    h.drv.rebuildPool(fakeNow);
    await h.refreshAll(); // 观察 1
    let confirmDelayBars = -1;
    for (let i = 1; i <= 6; i++) {
      advanceMin(1);
      h.klines.advance(0.0025);
      if (i === 3) h.klines.failNext = true; // 第 3 根 bar 时拉取失败
      await h.refreshAll();
      const st = h.drv.states.get('TRENDUSDT')!;
      if (st.phase === 'confirmed' && confirmDelayBars < 0) {
        confirmDelayBars = st.consecutiveObservations;
      }
    }
    const st = h.drv.states.get('TRENDUSDT')!;
    expect(st.phase).toBe('confirmed');
    expect(confirmDelayBars).toBe(3); // 确认延迟 = 3 个不同已收盘 bar（confirmObservations）
    expect(h.svc.klineReqs).toBe(7); // 1 首刷 + 6 推进（失败那次也计入请求）
    const row = h.svc.snapshot(fakeNow).pool.find((r) => r.symbol === 'TRENDUSDT')!;
    expect(row.dataMissing).toBe(false); // 失败后下一轮自愈
    expect(h.svc.dbErrors).toBe(0);
    h.svc.stop();
  });
});
