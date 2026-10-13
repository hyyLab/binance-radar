// Task 46 验证：冷却池链路（离线直喂聚合器，不依赖 dev server）
// 断言（§十 P1 语义另一面）：
//   1) MAJOR SPIKE P1 事件冲高回落 → 降出 P1 进冷却池（P3 + peakPriority=P1 + 方向不明）
//   2) 回落后热度回归（创新高）→ 重新达 P1 且 p1At 刷新
//   3) 假突破标记 → 冷却
//   4) 从未达 P1 的事件回落 → 不进冷却池（peakPriority 保持）
//   5) 有效突破 + 回落 → 仍 P1（突破有效性由 FALSE 链路单独判定，回落不冷却）
//   6) 动量衰减：sweep 静默 45s+ → 先降冷却；90s+ → 结束归档
//   7) sweep 降级后再触发 → 回 P1 + p1At 刷新
//   8) 前端冷却池条件覆盖 BAT 场景（曾P1 + P2 + 方向不明）
import { Aggregator, type FeedCtx } from '../src/lib/market/enhanced/aggregate';
import type { Detection, EnhancedEventDTO } from '../src/lib/market/enhanced/types';
import { AGG } from '../src/lib/market/enhanced/config';

let now = Date.now();
const snap = (over: Record<string, unknown> = {}) =>
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

const ctx = (over: Record<string, unknown> = {}): FeedCtx =>
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

/** 前端冷却池条件（与 enhanced-view.tsx 保持同步） */
const isCooled = (e: EnhancedEventDTO) =>
  e.priority !== 'P1' && e.peakPriority === 'P1' && e.direction.tendency === 'UNKNOWN';

const majorSpikeUp = (price: number): Detection => ({
  detector: 'SPIKE',
  dir: 'UP',
  level: 'MAJOR',
  magnitude: 2.4,
  price,
  detail: '1m +2.40%（MAJOR 阈值 2.00%）',
  windows: ['1m'],
  quoteVolume1m: 50_000,
});

console.log('1) MAJOR SPIKE P1 → 冲高回落过半 → 降出 P1 进冷却池');
const agg = new Aggregator();
const r1 = agg.feed(majorSpikeUp(1.0), ctx({ snap: snap({ price: 1.0 }) }));
check('触发即 P1', r1.event?.priority === 'P1', `实际 ${r1.event?.priority}`);
const p1At1 = r1.event?.p1At;
// 第二跳拉出事件高点 1.03
now += 4_000;
agg.feed(majorSpikeUp(1.03), ctx({ snap: snap({ price: 1.03 }), now }));
// 第三跳回落至 1.01：回撤 (1.03-1.01)/(1.03-1.0)=0.67 > 0.5 → retraced
now += 4_000;
const r3 = agg.feed(majorSpikeUp(1.01), ctx({ snap: snap({ price: 1.01, chg1m: 1.2 }), now }));
check('回落后 priority === P3', r3.event?.priority === 'P3', `实际 ${r3.event?.priority}`);
check('peakPriority 保持 P1（曾达P1 身份不灭）', r3.event?.peakPriority === 'P1');
check('方向转不明', r3.event?.direction.tendency === 'UNKNOWN');
check('冷却池条件命中（前端 isCooled）', r3.event ? isCooled(r3.event) : false);
check('p1At 保留（仍显示首次进入P1时刻）', r3.event?.p1At === p1At1);
check('headline 同步 [P3]', r3.event?.headline.includes('[P3]') === true, r3.event?.headline);

console.log('2) 热度回归（价格创新高）→ 重新达 P1 且 p1At 刷新');
now += 4_000;
const r4 = agg.feed(majorSpikeUp(1.035), ctx({ snap: snap({ price: 1.035, chg1m: 3.0 }), now }));
check('创新高后回到 P1', r4.event?.priority === 'P1', `实际 ${r4.event?.priority}`);
check('p1At 刷新为最近一次进入P1', r4.event?.p1At !== p1At1 && r4.event?.p1At === now);

console.log('3) 假突破标记 → 冷却池');
const agg2 = new Aggregator();
const dBO: Detection = {
  detector: 'BREAKOUT',
  dir: 'UP',
  level: 'MAJOR',
  magnitude: 0.4,
  price: 1.0,
  detail: '突破 24h 滚动前高 1.000（超越 0.40%）',
  baseline: 1.0,
  confirmVia: 'TICKS',
  quoteVolume1m: 50_000,
};
const rb = agg2.feed(dBO, ctx({ snap: snap({ price: 1.004 }), now }));
check('有效突破即 P1', rb.event?.priority === 'P1', `实际 ${rb.event?.priority}`);
now += 10_000;
const rf = agg2.markFalseBreakout(
  { ...dBO, magnitude: -0.1, detail: '价格回到区间内，标记假突破' },
  ctx({ snap: snap({ price: 0.999 }), now }),
);
check('假突破后 priority === P3', rf.event?.priority === 'P3', `实际 ${rf.event?.priority}`);
check('假突破后方向不明', rf.event?.direction.tendency === 'UNKNOWN');
check('冷却池条件命中', rf.event ? isCooled(rf.event) : false);

console.log('4) 从未达 P1 的 MINOR 事件回落 → 不进冷却池');
const agg3 = new Aggregator();
const dMinor: Detection = { ...majorSpikeUp(1.0), level: 'MINOR', magnitude: 1.1, detail: '1m +1.10%' };
agg3.feed(dMinor, ctx({ snap: snap({ price: 1.0 }), now }));
now += 4_000;
agg3.feed(dMinor, ctx({ snap: snap({ price: 1.012 }), now }));
now += 4_000;
const rm = agg3.feed(dMinor, ctx({ snap: snap({ price: 1.005 }), now }));
check('MINOR 回落仍 P3（普通记录，非冷却）', rm.event?.priority === 'P3');
check('peakPriority 保持 P3（从未达 P1）', rm.event?.peakPriority === 'P3');
check('冷却池条件不命中', rm.event ? !isCooled(rm.event) : true);

console.log('5) 有效突破 + 回落 → 仍 P1（突破有效性优先，不按回撤冷却）');
const agg4 = new Aggregator();
agg4.feed(dBO, ctx({ snap: snap({ price: 1.004 }), now }));
now += 4_000;
agg4.feed(
  { ...majorSpikeUp(1.006), detail: '突破伴随急拉' },
  ctx({ snap: snap({ price: 1.006 }), now }),
);
now += 4_000;
const rr = agg4.feed(
  { ...majorSpikeUp(1.0045), detail: '急拉后回落' },
  ctx({ snap: snap({ price: 1.0045 }), now }),
);
check('有效突破事件回落后仍 P1', rr.event?.priority === 'P1', `实际 ${rr.event?.priority}`);
check('冷却池条件不命中', rr.event ? !isCooled(rr.event) : true);

console.log('6) 动量衰减：sweep 静默 45s+ 先降冷却 → 90s+ 结束归档');
const agg5 = new Aggregator();
const t0 = now;
const rs = agg5.feed(majorSpikeUp(1.0), ctx({ snap: snap({ price: 1.0 }), now: t0 }));
check('触发即 P1', rs.event?.priority === 'P1');
agg5.sweep(t0 + AGG.coolDownQuietMs + 5_000); // 静默 50s
const after = [...agg5.list(t0 + AGG.coolDownQuietMs + 5_000).active];
const cooledEv = after.find((e) => e.id === rs.event?.id);
check('静默 50s 后降出 P1（进冷却池）', cooledEv?.priority === 'P3', `实际 ${cooledEv?.priority}`);
check('peakPriority 保持 P1', cooledEv?.peakPriority === 'P1');
check('冷却池条件命中', cooledEv ? isCooled(cooledEv) : false);
agg5.sweep(t0 + AGG.quietEndMs + 5_000); // 静默 95s → 结束
const endedList = agg5.list(t0 + AGG.quietEndMs + 5_000).ended;
const endedEv = endedList.find((e) => e.id === rs.event?.id);
check('静默 95s 后结束归档', endedEv?.state === 'ENDED');

console.log('7) sweep 降级后再触发 → 回 P1 + p1At 刷新');
const agg6 = new Aggregator();
const t6 = now + 200_000;
const rs6 = agg6.feed(majorSpikeUp(1.0), ctx({ snap: snap({ price: 1.0 }), now: t6 }));
const p1At6 = rs6.event?.p1At;
agg6.sweep(t6 + AGG.coolDownQuietMs + 5_000); // 降冷却
const reUp = agg6.feed(
  majorSpikeUp(1.028),
  ctx({ snap: snap({ price: 1.028, chg1m: 2.8 }), now: t6 + AGG.coolDownQuietMs + 30_000 }),
);
check('再触发后回到 P1', reUp.event?.priority === 'P1', `实际 ${reUp.event?.priority}`);
check('p1At 刷新为重进 P1 时刻', reUp.event?.p1At !== p1At6 && reUp.event?.p1At === t6 + AGG.coolDownQuietMs + 30_000);

console.log('8) 前端冷却池条件覆盖 BAT 场景（曾P1 + P2 + 方向不明，不再挤在 P2 池）');
const batLike = {
  priority: 'P2',
  peakPriority: 'P1',
  direction: { tendency: 'UNKNOWN' },
} as unknown as EnhancedEventDTO;
check('P2 + 曾P1 + UNKNOWN → 冷却池条件命中', isCooled(batLike));
const p2Kept = {
  priority: 'P2',
  peakPriority: 'P2',
  direction: { tendency: 'LONG' },
} as unknown as EnhancedEventDTO;
check('普通 P2（方向明确）→ 留在 P2 池', !isCooled(p2Kept));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
