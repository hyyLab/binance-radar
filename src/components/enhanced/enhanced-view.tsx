'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEnhancedAnomalies } from '@/hooks/use-enhanced';
import { fmtAgo, fmtAgoShort, fmtHM, fmtPrice, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TradeModal, type TradeIntent } from '@/components/scanner/trade-modal';
import { CoinDialog } from '@/components/market/coin-dialog';
import { PositionsPanel } from './positions-panel';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  Radar,
  ShieldCheck,
} from 'lucide-react';
import type { EnhancedEventDTO } from '@/lib/market/enhanced/types';

/** 强度徽章 */
function LevelBadge({ level }: { level: 'MINOR' | 'MAJOR' }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide',
        level === 'MAJOR' ? 'bg-gold text-background' : 'bg-secondary text-muted-foreground',
      )}
    >
      {level}
    </span>
  );
}

/** 优先级徽章 */
function PriorityBadge({ p }: { p: 'P1' | 'P2' | 'P3' }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-bold',
        p === 'P1'
          ? 'bg-down/20 text-down ring-1 ring-down/40'
          : p === 'P2'
            ? 'bg-gold/15 text-gold'
            : 'bg-secondary text-muted-foreground',
      )}
    >
      {p}
    </span>
  );
}

/** 方向倾向 */
function TendencyTag({ t }: { t: 'LONG' | 'SHORT' | 'UNKNOWN' }) {
  if (t === 'LONG') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-up/15 px-1.5 py-0.5 text-xs font-semibold text-up">
        <ArrowUpRight className="h-3 w-3" /> 偏多
      </span>
    );
  }
  if (t === 'SHORT') {
    return (
      <span className="inline-flex items-center gap-0.5 rounded bg-down/15 px-1.5 py-0.5 text-xs font-semibold text-down">
        <ArrowDownRight className="h-3 w-3" /> 偏空
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      方向不明
    </span>
  );
}

/** 确认程度 */
function ConfirmTag({ c }: { c: string }) {
  const multi = c === '多重确认';
  const double = c === '双重确认';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
        multi
          ? 'bg-gold/15 font-semibold text-gold'
          : double
            ? 'bg-gold/10 text-gold/90'
            : 'bg-secondary text-muted-foreground',
      )}
    >
      {multi || double ? <ShieldCheck className="h-3 w-3" /> : null}
      {c}
    </span>
  );
}

function EvidenceChips({ kinds }: { kinds: string[] }) {
  const unique = [...new Set(kinds)];
  return (
    <div className="flex flex-wrap gap-1">
      {unique.map((k, i) => (
        <span
          key={`${k}-${i}`}
          className="rounded border border-border/70 bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {k}
        </span>
      ))}
    </div>
  );
}

function EventCard({
  ev,
  onTrade,
  onSelectSymbol,
}: {
  ev: EnhancedEventDTO;
  onTrade: (symbol: string, side: 'LONG' | 'SHORT') => void;
  onSelectSymbol: (symbol: string) => void;
}) {
  const tradable = ev.direction.tendency !== 'UNKNOWN' && ev.state === 'ACTIVE';
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-3 sm:p-4',
        ev.notify && ev.state === 'ACTIVE'
          ? 'border-gold/60 shadow-[0_0_12px_-4px] shadow-gold/40'
          : 'border-border/70',
        ev.state === 'ENDED' && 'opacity-60',
      )}
    >
      {/* 头行 */}
      <div className="flex flex-wrap items-center gap-2">
        <LevelBadge level={ev.level} />
        <PriorityBadge p={ev.priority} />
        {ev.peakPriority === 'P1' && ev.priority !== 'P1' && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">曾达P1</span>
        )}
        <button
          className="font-mono text-sm font-bold tracking-wide hover:text-gold"
          onClick={() => onSelectSymbol(ev.symbol)}
        >
          {ev.base}
          <span className="text-muted-foreground">/USDT</span>
        </button>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {fmtPrice(ev.lastPrice)}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {ev.state === 'ENDED' ? '已结束 · ' : ''}
          {fmtAgo(ev.updatedAt)}
        </span>
      </div>

      {/* 规格书 §十一 通知明细 */}
      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        {ev.lines.map((l, i) => (
          <div key={i} className="leading-relaxed">
            {l}
          </div>
        ))}
      </div>

      {/* 判定原因 */}
      {ev.direction.reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground/90">
          {ev.direction.reasons.map((r, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-gold/70">·</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 证据 */}
      <div className="mt-2">
        <EvidenceChips kinds={ev.evidence.map((e) => e.kind)} />
      </div>

      {/* 操作：异动识别与交易建议分开——方向不明不给按钮（§一 设计目标） */}
      <div className="mt-3 flex items-center gap-2">
        {tradable ? (
          <>
            <button
              className="rounded-md bg-up/15 px-3 py-1.5 text-xs font-semibold text-up transition-colors hover:bg-up/25"
              onClick={() => onTrade(ev.symbol, 'LONG')}
            >
              买入做多
            </button>
            <button
              className="rounded-md bg-down/15 px-3 py-1.5 text-xs font-semibold text-down transition-colors hover:bg-down/25"
              onClick={() => onTrade(ev.symbol, 'SHORT')}
            >
              卖出做空
            </button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <CircleAlert className="h-3.5 w-3.5" />
            方向不明 · 检测到异动不代表存在可交易机会
          </span>
        )}
        <button
          className="ml-auto rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-gold/50 hover:text-gold"
          onClick={() => onSelectSymbol(ev.symbol)}
        >
          查看 K 线
        </button>
      </div>
    </div>
  );
}

// ============ 事件池看板 ============
// 展示设计（直观感知变化）：
//  1. 池内卡片按触发顺序排队（服务端稳定排序），永不重排 → 不跳动；
//  2. 事件升级（P3→P2→P1）或结束时「换池」，位置移动本身就是变化信号；
//  3. 变化（升级/新证据/方向变化/换池）的卡片亮金圈 8 秒；
//  4. 点击卡片在下方展开完整事件明细（替代整页大卡片）。

const FLASH_MS = 8_000;
const CONFIRM_SHORT: Record<string, string> = {
  MULTI: '多',
  DOUBLE: '双',
  SINGLE: '单',
  PENDING: '待',
};

/** 事件签名：任一实质字段变化 → 卡片高亮 */
function eventSig(ev: EnhancedEventDTO): string {
  return [
    ev.state,
    ev.level,
    ev.priority,
    ev.direction.tendency,
    ev.direction.confirm,
    ev.breakout.status,
    [...new Set(ev.evidence.map((e) => e.kind))].join(','),
  ].join('|');
}

function EventChip({
  ev,
  flashing,
  selected,
  onSelect,
}: {
  ev: EnhancedEventDTO;
  flashing: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const chg = ev.chg1m ?? ev.chg5m;
  const up = ev.dir === 'UP';
  return (
    <button
      onClick={() => onSelect(ev.id)}
      className={cn(
        'rounded-lg border px-2.5 py-1.5 text-left transition-all',
        selected
          ? 'border-gold/70 bg-gold/10'
          : 'border-border/60 bg-background/40 hover:border-gold/40',
        flashing && 'animate-pulse ring-2 ring-gold/70 shadow-[0_0_12px_-2px] shadow-gold/50',
      )}
      title={`${ev.base} ${ev.priority}${ev.peakPriority === 'P1' && ev.priority !== 'P1' ? '（曾P1）' : ''} ${ev.level} · 触发于 ${fmtHM(ev.firstAt)}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-xs font-bold">{ev.base}</span>
        {ev.level === 'MAJOR' && <span className="h-1.5 w-1.5 rounded-full bg-gold" />}
        {ev.peakPriority === 'P1' && ev.priority !== 'P1' && (
          <span className="rounded bg-secondary px-1 text-[9px] font-semibold text-muted-foreground">曾P1</span>
        )}
        <span className={cn('ml-auto shrink-0', up ? 'text-up' : 'text-down')}>
          {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
        <span className={cn('shrink-0', chg == null ? '' : chg >= 0 ? 'text-up' : 'text-down')}>
          {chg == null ? (ev.volumeMultiple != null ? `${ev.volumeMultiple.toFixed(1)}×量` : '—') : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`}
        </span>
        <span className="shrink-0">证×{new Set(ev.evidence.map((e) => e.kind)).size}</span>
        <span className="ml-auto shrink-0">{fmtAgoShort(ev.firstAt)}</span>
        <span className="shrink-0 font-semibold text-foreground/70">
          {CONFIRM_SHORT[ev.direction.confirm] ?? '待'}
        </span>
      </div>
    </button>
  );
}

function Pool({
  title,
  desc,
  count,
  cls,
  children,
}: {
  title: string;
  desc: string;
  count: number;
  cls?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('rounded-lg border bg-card/40', cls)}>
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <span className="text-xs font-bold">{title}</span>
        <span className="rounded-full bg-secondary px-1.5 text-[10px] tabular-nums text-muted-foreground">
          {count}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">{desc}</span>
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}

function StatsBar(props: {
  tracked: number;
  baselineReady: number;
  bootDone: number;
  bootTotal: number;
  active: number;
  outbound: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/70 bg-card px-4 py-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 font-semibold text-foreground">
        <Radar className="h-4 w-4 text-gold" />
        升级版异动引擎
      </span>
      <span className="tabular-nums">
        监控 <span className="font-semibold text-foreground">{props.tracked}</span> 个 · 基线就绪{' '}
        <span className="font-semibold text-foreground">{props.baselineReady}</span>
      </span>
      {props.bootDone < props.bootTotal && (
        <span className="text-gold">
          历史回填中 {props.bootDone}/{props.bootTotal}（回填完成前部分标的用固定阈值）
        </span>
      )}
      <span className="tabular-nums">活跃事件 {props.active}</span>
      <span className="tabular-nums">引擎出站 {props.outbound} req（独立计数）</span>
      <span className="hidden lg:inline">
        滚动 24h 基线由已收盘 1m K 线计算 · 自适应阈值 · 多重证据聚合 · 方向可输出「不明」
      </span>
    </div>
  );
}

export function EnhancedView() {
  const { data, isLoading, isError } = useEnhancedAnomalies();
  const [tradeIntent, setTradeIntent] = useState<TradeIntent | null>(null);
  const [tradeKey, setTradeKey] = useState(0);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const active = useMemo(() => data?.events.active ?? [], [data]);
  const ended = useMemo(() => data?.events.ended ?? [], [data]);
  // 已结束池只归档重要事件：MAJOR 档且曾进入 P1 紧急池（其余结束事件仅引擎内部记录）
  const endedShown = useMemo(
    () => ended.filter((e) => e.level === 'MAJOR' && e.peakPriority === 'P1'),
    [ended],
  );
  const stats = data?.stats;

  // --- 变化高亮：对每个事件维护签名，签名变化 → 亮 8 秒（换池/升级/新证据/方向变化都会改签名） ---
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000); // 心跳：让高亮到点熄灭
    return () => clearInterval(t);
  }, []);
  const sigRef = useRef<Map<string, string> | null>(null);
  const [flashAt, setFlashAt] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!data) return; // 首次数据未到不比较
    const now = Date.now();
    const added: Record<string, number> = {};
    const next = new Map<string, string>();
    for (const ev of [...active, ...ended]) {
      const sig = eventSig(ev);
      next.set(ev.id, sig);
      const prev = sigRef.current?.get(ev.id);
      // 已见过且签名变化，或首次出现（新事件/新结束事件）→ 高亮；首次加载（sigRef 空）不亮
      if (sigRef.current && prev !== sig) {
        added[ev.id] = now;
      }
    }
    sigRef.current = next;
    if (Object.keys(added).length > 0) setFlashAt((f) => ({ ...f, ...added }));
  }, [data, active, ended]);

  const flashing = (id: string) => (flashAt[id] ?? 0) > Date.now() - FLASH_MS;

  // --- 池分组：沿用服务端稳定排序（优先级 + 触发时间队列序），过滤不改顺序 ---
  const p1 = active.filter((e) => e.priority === 'P1');
  const p2 = active.filter((e) => e.priority === 'P2');
  // 第三池（替代原 P3 池）：曾进入 P1 紧急池、优先级回落且方向转不明的「冷却」事件；
  // 其余普通 P3（从未达到 P1）不再展示，仅引擎内部记录。
  const cooled = active.filter(
    (e) => e.priority === 'P3' && e.peakPriority === 'P1' && e.direction.tendency === 'UNKNOWN',
  );
  const selectedEvent =
    [...active, ...ended].find((e) => e.id === selectedEventId) ?? null;

  const openTrade = (symbol: string, side: 'LONG' | 'SHORT') => {
    setTradeIntent({ open: true, symbol, side });
    setTradeKey((k) => k + 1);
  };
  const openManual = () => {
    setTradeIntent({ open: true });
    setTradeKey((k) => k + 1);
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-5">
        {/* 引擎状态条 */}
        {stats && (
          <StatsBar
            tracked={stats.tracked}
            baselineReady={stats.baselineReady}
            bootDone={stats.bootBackfillDone}
            bootTotal={stats.bootBackfillTotal}
            active={stats.activeEvents}
            outbound={stats.outboundRequests}
          />
        )}

        {/* 事件池 */}
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Activity className="h-4 w-4 text-gold" />
            <h2 className="text-sm font-bold sm:text-base">异动事件池</h2>
            <span className="text-xs text-muted-foreground">
              池内按触发顺序排队不跳动 · 升级/结束时移池并亮起 · 点击卡片查看明细
            </span>
          </div>

          {isLoading && (
            <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {isError && (
            <div className="rounded-lg border border-down/40 bg-down/10 px-4 py-6 text-center text-sm text-down">
              引擎数据加载失败，稍后自动重试
            </div>
          )}
          {!isLoading && !isError && active.length === 0 && ended.length === 0 && (
            <div className="rounded-lg border border-border/70 bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              暂无异动事件 · 引擎正在按升级规则监控（急拉急跌 / 有效突破 / 异常放量三类证据独立检测、相互印证）
            </div>
          )}
          {!isLoading && !isError && (
            <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
              {/* P1 紧急池 */}
              <Pool
                title="P1 · 紧急关注"
                desc="已确认 MAJOR 急拉急跌 / 有效突破 / 多重印证"
                count={p1.length}
                cls={p1.length > 0 ? 'border-down/40' : 'border-border/50 opacity-70'}
              >
                {p1.length === 0 ? (
                  <div className="px-1 py-1.5 text-center text-[11px] text-muted-foreground">暂无</div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
                    {p1.map((ev) => (
                      <EventChip
                        key={ev.id}
                        ev={ev}
                        flashing={flashing(ev.id)}
                        selected={selectedEventId === ev.id}
                        onSelect={setSelectedEventId}
                      />
                    ))}
                  </div>
                )}
              </Pool>

              {/* P2 观察池 */}
              <Pool
                title="P2 · 观察"
                desc="MINOR+第二证据 / 普通有效突破 / 显著放量方向明确"
                count={p2.length}
                cls={p2.length > 0 ? 'border-gold/40' : 'border-border/50 opacity-70'}
              >
                {p2.length === 0 ? (
                  <div className="px-1 py-1.5 text-center text-[11px] text-muted-foreground">暂无</div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
                    {p2.map((ev) => (
                      <EventChip
                        key={ev.id}
                        ev={ev}
                        flashing={flashing(ev.id)}
                        selected={selectedEventId === ev.id}
                        onSelect={setSelectedEventId}
                      />
                    ))}
                  </div>
                )}
              </Pool>

              {/* 冷却池：曾达P1 + 方向不明（替代原 P3 池） */}
              <Pool
                title="冷却 · 曾达P1"
                desc="曾进入 P1 紧急池，现方向不明（冲高回落 / 动量衰减 / 假突破）"
                count={cooled.length}
                cls={cooled.length > 0 ? 'border-gold/40' : 'border-border/50 opacity-70'}
              >
                {cooled.length === 0 ? (
                  <div className="px-1 py-1.5 text-center text-[11px] text-muted-foreground">暂无</div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-4">
                    {cooled.map((ev) => (
                      <EventChip
                        key={ev.id}
                        ev={ev}
                        flashing={flashing(ev.id)}
                        selected={selectedEventId === ev.id}
                        onSelect={setSelectedEventId}
                      />
                    ))}
                  </div>
                )}
              </Pool>

              {/* 已结束池：仅 MAJOR·曾达P1 + 紧凑行 + 保留最近 N 条（滚动） */}
              <Pool
                title="已结束 · 最近优先"
                desc={`仅 MAJOR·曾达P1 · 保留最近 ${endedShown.length} 条（最多 80）`}
                count={endedShown.length}
                cls="border-border/40"
              >
                {endedShown.length === 0 ? (
                  <div className="px-1 py-1.5 text-center text-[11px] text-muted-foreground">
                    暂无 · 仅归档 MAJOR 且曾进入 P1 紧急池的事件
                  </div>
                ) : (
                  <div className="custom-scroll max-h-44 space-y-0.5 overflow-y-auto">
                    {endedShown.slice(0, 80).map((ev) => (
                      <button
                        key={ev.id}
                        onClick={() => setSelectedEventId(ev.id)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] tabular-nums hover:bg-secondary/40',
                          selectedEventId === ev.id && 'bg-gold/10',
                          flashing(ev.id) && 'animate-pulse ring-1 ring-gold/70',
                        )}
                      >
                        <span className="w-14 shrink-0 text-muted-foreground">{fmtTime(ev.firstAt)}</span>
                        <span className="w-16 shrink-0 truncate font-mono font-semibold">{ev.base}</span>
                        <span className={cn('shrink-0', ev.dir === 'UP' ? 'text-up' : 'text-down')}>
                          {ev.dir === 'UP' ? '↑' : '↓'}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 font-bold',
                            ev.level === 'MAJOR' ? 'text-gold' : 'text-muted-foreground',
                          )}
                        >
                          {ev.level === 'MAJOR' ? '大' : '小'}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {ev.volumeMultiple != null ? `${ev.volumeMultiple.toFixed(1)}×量` : ''}
                          {ev.breakout.status === 'CONFIRMED' ? ' 有效突破' : ''}
                          {ev.breakout.status === 'FALSE' ? ' 假突破' : ''}
                        </span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {fmtAgo(ev.updatedAt)}结束
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Pool>
            </div>
          )}
        </div>

        {/* 事件明细（点击池中卡片展开） */}
        {selectedEvent ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">事件明细</span>
              <span>更新于 {fmtAgo(selectedEvent.updatedAt)}</span>
              <button
                className="ml-auto rounded border border-border px-2 py-0.5 hover:text-foreground"
                onClick={() => setSelectedEventId(null)}
              >
                收起
              </button>
            </div>
            <EventCard
              ev={selectedEvent}
              onTrade={openTrade}
              onSelectSymbol={setSelectedSymbol}
            />
          </div>
        ) : (
          !isLoading &&
          !isError && (
            <div className="rounded-lg border border-dashed border-border/60 px-4 py-3 text-center text-xs text-muted-foreground">
              点击池中任意代币卡片，在这里查看该事件的完整明细（通知格式 / 判定原因 / 证据 / 交易操作）
            </div>
          )
        )}

        {/* 持仓明细：与模拟盘同账户（3s 轮询），本页直接盯涨跌 + 一键平仓 */}
        <PositionsPanel onSelectSymbol={setSelectedSymbol} onManualTrade={openManual} />
      </div>

      <TradeModal key={tradeKey} intent={tradeIntent} onClose={() => setTradeIntent(null)} />
      <CoinDialog symbol={selectedSymbol} onClose={() => setSelectedSymbol(null)} />
    </>
  );
}
