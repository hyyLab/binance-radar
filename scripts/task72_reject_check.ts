// Task 72 功能验证：major-p1 事件路径的拒绝应返回带原因的结论（而非静默 null）
// 运行：bun scripts/task72_reject_check.ts
import { MajorP1BreakoutStrategy } from '../src/lib/market/trend-trade/strategy/major-p1-breakout';

const NOW = Date.now();

function fakeCtx(mark: number) {
  return {
    now: NOW,
    mark,
    cfg: {} as never,
    equity: { balance: 100, marginUsed: 0, unrealized: 0, equity: 100, openCount: 0 },
    openSymbols: new Set<string>(),
    lastCloseAt: null,
  };
}

function fakeEvent(overrides: Record<string, unknown>) {
  return {
    id: 'evt-test-1',
    symbol: 'FAKEUSDT',
    state: 'ACTIVE',
    level: 'MAJOR',
    priority: 'P1',
    peakPriority: 'P1',
    dir: 'UP',
    firstAt: NOW - 60_000,
    p1At: NOW - 60_000,
    quoteVolume1m: 100_000,
    chg1m: 1.0,
    chg5m: 2.0,
    breakout: { status: 'PENDING', baseline: null },
    direction: { tendency: 'UNKNOWN' },
    ...overrides,
  } as never;
}

const s = new MajorP1BreakoutStrategy();

// 用例 1：P1 已过期（年龄 60s > 12s 窗口）→ 应返回「P1 已过期」而非 null
const r1 = s.evaluateMajorEventEntry({
  event: fakeEvent({}),
  candles: [],
  quoteVolume24h: 50_000_000,
  ctx: fakeCtx(100),
});
console.log('case1(P1 过期):', JSON.stringify(r1));
if (r1 == null || r1.want !== false || !/P1 已过期/.test(r1.reason)) {
  console.error('FAIL: case1 应返回带「P1 已过期」原因的拒绝');
  process.exit(1);
}

// 用例 2：P1 新鲜但 24h 成交额不足 → 「24h 成交额不足」
const r2 = s.evaluateMajorEventEntry({
  event: fakeEvent({ p1At: NOW - 3_000, firstAt: NOW - 3_000 }),
  candles: [],
  quoteVolume24h: 1_000_000,
  ctx: fakeCtx(100),
});
console.log('case2(24h 量不足):', JSON.stringify(r2));
if (r2 == null || r2.want !== false || !/24h 成交额不足/.test(r2.reason)) {
  console.error('FAIL: case2 应返回带「24h 成交额不足」原因的拒绝');
  process.exit(1);
}

// 用例 3：1m 成交额不足 → 「1m 成交额不足」
const r3 = s.evaluateMajorEventEntry({
  event: fakeEvent({ p1At: NOW - 3_000, firstAt: NOW - 3_000, quoteVolume1m: 5_000 }),
  candles: [],
  quoteVolume24h: 50_000_000,
  ctx: fakeCtx(100),
});
console.log('case3(1m 量不足):', JSON.stringify(r3));
if (r3 == null || r3.want !== false || !/1m 成交额不足/.test(r3.reason)) {
  console.error('FAIL: case3 应返回带「1m 成交额不足」原因的拒绝');
  process.exit(1);
}

// 用例 4：预过滤分支（非 MAJOR）仍返回 null（不产生噪音）
const r4 = s.evaluateMajorEventEntry({
  event: fakeEvent({ level: 'MINOR' }),
  candles: [],
  quoteVolume24h: 50_000_000,
  ctx: fakeCtx(100),
});
console.log('case4(非 MAJOR 预过滤):', r4);
if (r4 !== null) {
  console.error('FAIL: case4 预过滤分支应保持 null');
  process.exit(1);
}

console.log('ALL PASS: 拒绝原因已接入事件路径（预过滤仍静默）');
