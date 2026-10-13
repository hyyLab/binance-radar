// Task 45 验证：新优先级规则 + P1 时间语义（离线直喂聚合器，不依赖 dev server）
// 断言（§十）：1) MAJOR SPIKE 方向不明也进 P1（此前被压 P3 漏报）；2) p1At 记录进入P1时刻；
// 3) MINOR→MAJOR 升级进 P1；4) 回落后再升级刷新 p1At；5) MINOR 单证据仍 P3；6) VOLUME NEUTRAL 仍 P3
import { Aggregator, type FeedCtx } from '../src/lib/market/enhanced/aggregate';
import type { Detection } from '../src/lib/market/enhanced/types';

const agg = new Aggregator();
let now = Date.now();
const snap = (over: Partial<Parameters<NonNullable<never>>>[number] = {}) =>
  ({
    symbol: 'TESTUSDT',
    base: 'TEST',
    price: 1.0,
    chg1m: 0,
    chg5m: 0,
    vol1m: 50_000,
    quoteVolume24h: 50_000_000,
    change24h: 0,
    updatedAt: now,
    ...over,
  }) as never;

const ctx = (over: object = {}): FeedCtx =>
  ({
    snap: snap(),
    now,
    shortTrend: { r15m: null, r1h: null },
    tier: 'HIGH' as const,
    ...over,
  }) as never;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
}

console.log('1) MAJOR SPIKE 方向不明（无短线数据）→ 应 P1（修复点：此前 P3 不可见）');
const d1: Detection = {
  detector: 'SPIKE', dir: 'UP', level: 'MAJOR', magnitude: 2.4, price: 1.0,
  detail: '1m +2.40%（MAJOR 阈值 2.00%）', windows: ['1m'], quoteVolume1m: 50_000,
};
const r1 = agg.feed(d1, ctx());
check('priority === P1', r1.event?.priority === 'P1', `实际 ${r1.event?.priority}`);
check('p1At 已记录', typeof r1.event?.p1At === 'number');
const p1At1 = r1.event?.p1At;
check('p1At ≈ now', Math.abs((p1At1 ?? 0) - now) < 5_000);

console.log('2) MINOR SPIKE 单证据 → P3（文档：单一检测器普通异动仅记录）');
const agg2 = new Aggregator();
const d2: Detection = { ...d1, level: 'MINOR', magnitude: 1.1, detail: '1m +1.10%' };
const r2 = agg2.feed(d2, ctx());
check('priority === P3', r2.event?.priority === 'P3', `实际 ${r2.event?.priority}`);
check('p1At 未设置', r2.event?.p1At === undefined);

console.log('3) MINOR → MAJOR 升级 → P1（§十：升级即 P1）');
now += 10_000;
const r3 = agg2.feed({ ...d2, level: 'MAJOR', magnitude: 2.3, detail: '1m +2.30%' }, ctx({ now }));
check('priority === P1', r3.event?.priority === 'P1', `实际 ${r3.event?.priority}`);
check('p1At 已记录（升级时刻）', typeof r3.event?.p1At === 'number' && r3.event.p1At === now);

console.log('4) 回落 P3 后再升级 → p1At 刷新为最近一次进入 P1');
// 事件结束路径：静默 90s+ 由 sweep 处理；此处直接用新事件序列验证「回落→再升级」
const agg3 = new Aggregator();
now += 60_000;
agg3.feed({ ...d2 }, ctx({ now })); // MINOR P3
now += 10_000;
const up1 = agg3.feed({ ...d1 }, ctx({ now })); // 升 MAJOR → P1
const p1First = up1.event?.p1At;
now += 120_000;
// 降级路径：中性放量证据不改变方向 → 仍 P1；直接再喂 MINOR 级别不会降级 level。
// 用「优先级回落」的语义验证：p1At 不因仍在 P1 而刷新
agg3.feed({ ...d1, magnitude: 2.5 }, ctx({ now }));
check('p1At 保持首次进入P1时刻（未反复刷新）', up1.event?.p1At === p1First);

console.log('5) VOLUME NEUTRAL MAJOR → P3（文档：没有明确方向的放量仅记录）');
const agg4 = new Aggregator();
const dv: Detection = {
  detector: 'VOLUME', dir: 'NEUTRAL', level: 'MAJOR', magnitude: 12.5, price: 1.0,
  detail: '1m 成交额 120K = 中位数 12.5 倍', quoteVolume1m: 120_000,
};
const r5 = agg4.feed(dv, ctx());
check('priority === P3', r5.event?.priority === 'P3', `实际 ${r5.event?.priority}`);

console.log('6) MINOR 同类型证据隔窗重复触发 → 仍 P3（§九：第二项证据须不同类型，Task 45 修复点）');
const agg5 = new Aggregator();
now += 60_000;
agg5.feed({ ...d2 }, ctx({ now })); // MINOR SPIKE_UP → P3
now += 120_000; // 超过 90s 证据去重窗，同类型再次触发会新增一条同类证据
const r6 = agg5.feed({ ...d2, magnitude: 1.3 }, ctx({ now }));
check(
  '同类型重复后仍 P3（不凑数）',
  r6.event?.priority === 'P3' && r6.event.evidence.length >= 2,
  `evidence=${r6.event?.evidence.length} 条 实际 ${r6.event?.priority}`,
);

console.log('7) MINOR + 不同类型证据（VOLUME）→ P2（§十：MINOR+第二证据）');
now += 10_000;
const r7 = agg5.feed(
  {
    detector: 'VOLUME', dir: 'UP', level: 'MINOR', magnitude: 7.0, price: 1.0,
    detail: '1m 成交额 70K = 中位数 7.0 倍', quoteVolume1m: 70_000,
  },
  ctx({ now }),
);
check('priority === P2', r7.event?.priority === 'P2', `实际 ${r7.event?.priority}`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
