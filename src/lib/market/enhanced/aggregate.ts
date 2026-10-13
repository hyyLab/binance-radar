// ---------- 升级版异动交易 · 事件聚合 + 方向引擎 + 优先级 ----------
// §七：同一波行情一个事件，检测器结果进日志不丢；升级/新证据才重复通知。
// §八：方向由短线走势 + 24h 背景 + 突破有效性 + 成交量综合判断，允许"方向不明"。
// §九：事件强度（MINOR/MAJOR）与方向置信度分开计算。
// §十：P1 立即推送 / P2 合并后推送 / P3 汇总或仅记录。

import { AGG, DIRECTION, VOLUME } from './config';
import type {
  ConfirmLevel,
  Detection,
  EnhancedEventDTO,
  Evidence,
  EvidenceKind,
  Priority,
  Tendency,
} from './types';
import type { TickSnap } from './detectors';

interface ActiveEvent {
  dto: EnhancedEventDTO;
  lastDetectionAt: number; // 最后一次任一检测条件仍成立的时刻
  notified: {
    at: number;
    level: string;
    evidenceKinds: string;
    tendency: string;
    priority: string;
  };
  spikeRefPrice: number; // SPIKE 起点参考价（回撤风险判定）
}

export interface FeedCtx {
  snap: TickSnap;
  now: number;
  shortTrend: { r15m: number | null; r1h: number | null };
  tier: 'HIGH' | 'MID' | 'LOW' | 'NONE';
}

export interface FeedResult {
  action: 'CREATED' | 'MERGED' | 'UPGRADED' | 'EVIDENCE' | 'SUPPRESSED_COOLDOWN' | 'NO_EVENT';
  event: EnhancedEventDTO | null;
  notify: boolean;
}

export class Aggregator {
  private active = new Map<string, ActiveEvent>(); // key: symbol|DIR
  private ended: EnhancedEventDTO[] = [];
  private cooldown = new Map<string, number>(); // symbol|DIR -> 最后通知时刻（兜底）

  // ============ 事件聚合（§7.2/7.3/7.4） ============

  feed(d: Detection, ctx: FeedCtx): FeedResult {
    const { snap, now } = ctx;
    if (d.dir === 'NEUTRAL') return this.feedNeutralVolume(d, ctx);

    const dir = d.dir;
    const key = `${snap.symbol}|${dir}`;
    const existing = this.active.get(key);

    // 突破方向与事件方向冲突时（如 UP 事件中价格跌回），交给结束判定，不合并
    if (existing) {
      const fresh = now - existing.lastDetectionAt <= AGG.mergeWindowMs * 3;
      if (!fresh) this.endEvent(key, now);
    }
    const ev = this.active.get(key);

    // 兜底冷却：仅约束"新建事件"，升级/新证据不受限（§7.4）
    const lastCd = this.cooldown.get(key) ?? 0;
    if (!ev && now - lastCd < AGG.cooldownMs) {
      return { action: 'SUPPRESSED_COOLDOWN', event: null, notify: false };
    }

    const kind = evidenceKind(d);
    if (ev) {
      return this.mergeInto(ev, d, kind, ctx);
    }
    return this.createEvent(d, kind, ctx);
  }

  /** 中性放量：有活跃事件则挂证据（不改变方向），否则按 MAJOR 独立成事件（方向不明） */
  private feedNeutralVolume(d: Detection, ctx: FeedCtx): FeedResult {
    const { snap, now } = ctx;
    const alt = [...this.active.entries()].find(([k]) => k.startsWith(`${snap.symbol}|`));
    if (alt) {
      const ev = alt[1];
      const kind: EvidenceKind = 'VOLUME_NEUTRAL';
      const has = ev.dto.evidence.some((e) => e.kind === kind && now - e.at < AGG.mergeWindowMs);
      if (!has) {
        ev.dto.evidence.push({ kind, at: now, magnitude: d.magnitude, detail: d.detail });
        ev.dto.volumeMultiple = d.magnitude;
        this.rejudge(ev, ctx);
        return { action: 'EVIDENCE', event: ev.dto, notify: true };
      }
      ev.lastDetectionAt = now;
      return { action: 'NO_EVENT', event: ev.dto, notify: false };
    }
    // 无关联事件：仅 MAJOR 中性放量独立成事件（方向不明），MINOR 只记日志
    if (d.level !== 'MAJOR') return { action: 'NO_EVENT', event: null, notify: false };
    const dir: 'UP' | 'DOWN' = (snap.chg1m ?? 0) >= 0 ? 'UP' : 'DOWN';
    return this.createEvent({ ...d, dir }, 'VOLUME_NEUTRAL', ctx);
  }

  private createEvent(d: Detection, kind: EvidenceKind, ctx: FeedCtx): FeedResult {
    const { snap, now } = ctx;
    const key = `${snap.symbol}|${d.dir}`;
    const id = `${snap.symbol}|${d.dir}|${now}`;
    const dto: EnhancedEventDTO = {
      id,
      symbol: snap.symbol,
      base: snap.symbol.slice(0, -4),
      dir: d.dir,
      state: 'ACTIVE',
      level: d.level === 'PENDING' ? 'MINOR' : d.level,
      priority: 'P3',
      peakPriority: 'P3',
      notify: false,
      firstAt: now,
      updatedAt: now,
      price: d.price,
      lastPrice: snap.price,
      highDuringEvent: Math.max(d.price, snap.price),
      lowDuringEvent: Math.min(d.price, snap.price),
      chg1m: snap.chg1m,
      chg5m: snap.chg5m,
      volumeMultiple: d.detector === 'VOLUME' ? d.magnitude : null,
      quoteVolume1m: d.quoteVolume1m ?? snap.vol1m,
      breakout: {
        status: d.detector === 'BREAKOUT' ? (d.level === 'PENDING' ? 'PENDING' : 'CONFIRMED') : 'NONE',
        baseline: d.baseline ?? null,
        beyondPct: d.detector === 'BREAKOUT' ? d.magnitude : null,
        via: d.confirmVia ?? null,
      },
      evidence: [{ kind, at: now, magnitude: d.magnitude, detail: d.detail }],
      direction: { tendency: 'UNKNOWN', confirm: 'PENDING', reasons: [] },
      headline: '',
      lines: [],
    };
    const ev: ActiveEvent = {
      dto,
      lastDetectionAt: now,
      notified: { at: 0, level: '', evidenceKinds: '', tendency: '', priority: '' },
      spikeRefPrice: d.detector === 'SPIKE' ? d.price : snap.price,
    };
    this.active.set(key, ev);
    this.rejudge(ev, ctx);
    const notify = dto.priority !== 'P3'; // P3 仅记录（§十）
    if (notify) this.cooldown.set(key, now);
    return { action: 'CREATED', event: dto, notify };
  }

  private mergeInto(ev: ActiveEvent, d: Detection, kind: EvidenceKind, ctx: FeedCtx): FeedResult {
    const { snap, now } = ctx;
    const dto = ev.dto;
    ev.lastDetectionAt = now;
    dto.updatedAt = now;
    dto.lastPrice = snap.price;
    dto.highDuringEvent = Math.max(dto.highDuringEvent, snap.price, d.price);
    dto.lowDuringEvent = Math.min(dto.lowDuringEvent, snap.price, d.price);
    dto.chg1m = snap.chg1m;
    dto.chg5m = snap.chg5m;
    if (d.detector === 'VOLUME') dto.volumeMultiple = d.magnitude;
    if (d.quoteVolume1m) dto.quoteVolume1m = Math.max(dto.quoteVolume1m ?? 0, d.quoteVolume1m);

    const prevLevel = dto.level;
    const prevKinds = dto.evidence.map((e) => e.kind);
    const prevTendency = dto.direction.tendency;
    const prevBeyondPct = dto.breakout.beyondPct ?? 0; // 里程碑对比必须用更新前的值

    // 突破状态推进：PENDING → CONFIRMED
    if (d.detector === 'BREAKOUT' && d.level !== 'PENDING') {
      dto.breakout = {
        status: 'CONFIRMED',
        baseline: d.baseline ?? dto.breakout.baseline,
        beyondPct: d.magnitude,
        via: d.confirmVia ?? dto.breakout.via,
      };
      dto.level = 'MAJOR';
    } else if (d.detector === 'BREAKOUT') {
      dto.breakout.status = 'PENDING';
      dto.breakout.beyondPct = d.magnitude;
    }
    if (d.detector === 'SPIKE' && d.level === 'MAJOR') dto.level = 'MAJOR';
    if (d.detector === 'VOLUME' && d.level === 'MAJOR' && dto.level === 'MINOR' && prevKinds.length > 1) {
      dto.level = 'MAJOR';
    }

    // 证据去重（同类型 90s 内不重复记录，更新已有幅度）
    const dup = dto.evidence.find((e) => e.kind === kind && now - e.at < 90_000);
    if (dup) {
      dup.at = now;
      dup.magnitude = Math.abs(d.magnitude) > Math.abs(dup.magnitude) ? d.magnitude : dup.magnitude;
      dup.detail = d.detail;
    } else {
      dto.evidence.push({ kind, at: now, magnitude: d.magnitude, detail: d.detail });
    }

    this.rejudge(ev, ctx);

    // §7.4 通知判定：升级 / 新证据类型 / 方向变化 → 通知；仅再触发 → 不重复
    const kindAdded = !prevKinds.includes(kind) && kind !== 'VOLUME_NEUTRAL';
    const upgraded = prevLevel === 'MINOR' && dto.level === 'MAJOR';
    const dirChanged = prevTendency !== dto.direction.tendency;
    const milestone =
      dto.breakout.status === 'CONFIRMED' &&
      Math.abs(dto.breakout.beyondPct ?? 0) >= Math.abs(prevBeyondPct) * 2 &&
      Math.abs(dto.breakout.beyondPct ?? 0) > 0.5;
    const notify = (upgraded || kindAdded || dirChanged || milestone) && dto.priority !== 'P3';
    const action = upgraded ? 'UPGRADED' : kindAdded ? 'EVIDENCE' : 'MERGED';
    if (notify) this.cooldown.set(`${snap.symbol}|${dto.dir}`, now);
    return { action, event: dto, notify };
  }

  /** 假突破标记（由引擎在 tracker 返回 FALSE 检测时调用） */
  markFalseBreakout(d: Detection, ctx: FeedCtx): FeedResult {
    const { snap, now } = ctx;
    const key = `${snap.symbol}|${d.dir}`;
    const ev = this.active.get(key);
    if (!ev) return { action: 'NO_EVENT', event: null, notify: false };
    ev.dto.breakout.status = 'FALSE';
    ev.dto.breakout.beyondPct = d.magnitude;
    ev.dto.updatedAt = now;
    ev.lastDetectionAt = now;
    const kind: EvidenceKind = d.dir === 'UP' ? 'BREAKOUT_UP_PENDING' : 'BREAKOUT_DOWN_PENDING';
    ev.dto.evidence.push({ kind, at: now, magnitude: d.magnitude, detail: d.detail });
    this.rejudge(ev, ctx);
    return { action: 'EVIDENCE', event: ev.dto, notify: true };
  }

  // ============ 方向引擎（§八）+ 置信度（§九）============

  private rejudge(ev: ActiveEvent, ctx: FeedCtx): void {
    const { snap, now } = ctx;
    const dto = ev.dto;
    const kinds = new Set(dto.evidence.map((e) => e.kind));
    const reasons: string[] = [];
    let tendency: Tendency = 'UNKNOWN';
    let caution: string | undefined;

    const { r15m, r1h } = ctx.shortTrend;
    const chg24 = snap.change24h;
    const bull24 = chg24 >= DIRECTION.bull24h;
    const bear24 = chg24 <= DIRECTION.bear24h;
    const shortUp = (r15m != null && r15m >= DIRECTION.shortBull) || (r1h != null && r1h > 0);
    const shortDown = (r15m != null && r15m <= DIRECTION.shortBear) || (r1h != null && r1h < 0);

    const boConfirmed =
      dto.breakout.status === 'CONFIRMED' &&
      ((dto.dir === 'UP' && kinds.has('BREAKOUT_UP')) || (dto.dir === 'DOWN' && kinds.has('BREAKOUT_DOWN')));
    const boPending = dto.breakout.status === 'PENDING';
    const boFalse = dto.breakout.status === 'FALSE';

    if (dto.breakout.status === 'CONFIRMED' && (kinds.has('BREAKOUT_UP') || kinds.has('BREAKOUT_DOWN'))) {
      // §8.4/8.5 有效突破
      tendency = dto.dir === 'UP' ? 'LONG' : 'SHORT';
      reasons.push(
        dto.dir === 'UP'
          ? `有效突破 24h 滚动前高（超越 ${(dto.breakout.beyondPct ?? 0).toFixed(2)}%），价格持续处于突破位上方`
          : `有效跌破 24h 滚动前低（超出 ${(dto.breakout.beyondPct ?? 0).toFixed(2)}%），价格持续处于突破位下方`,
      );
      if (kinds.has('VOLUME_UP') || kinds.has('VOLUME_DOWN')) {
        reasons.push('突破伴随显著放量，短线结构支持');
      }
      if (shortUp && dto.dir === 'UP') reasons.push(`短线偏强（15m ${fmtPct(r15m)} / 1h ${fmtPct(r1h)}）`);
      if (shortDown && dto.dir === 'DOWN') reasons.push(`短线偏弱（15m ${fmtPct(r15m)} / 1h ${fmtPct(r1h)}）`);
    } else if (kinds.has('SPIKE_UP') || kinds.has('SPIKE_DOWN')) {
      // §8.2/8.3 急拉/急杀
      const up = kinds.has('SPIKE_UP');
      const retrace = this.spikeRetraced(ev, snap);
      if (retrace) {
        caution = up ? '冲高回落风险：急拉后未能维持涨幅' : '急跌后快速回收，注意假破位';
        tendency = 'UNKNOWN';
        reasons.push('事件期间价格已回撤超过振幅一半，方向证据减弱');
      } else if (up && shortUp) {
        tendency = 'LONG';
        reasons.push(`短线偏强（15m ${fmtPct(r15m)} / 1h ${fmtPct(r1h)}），动量顺势做多`);
        if (boConfirmed) reasons.push('且有效突破关键位，方向确认增强');
      } else if (!up && shortDown) {
        tendency = 'SHORT';
        reasons.push(`短线偏弱（15m ${fmtPct(r15m)} / 1h ${fmtPct(r1h)}），动量顺势做空`);
        if (boConfirmed) reasons.push('且有效跌破关键位，方向确认增强');
      } else if (up && bear24) {
        caution = '24h 偏弱背景下的快速反弹，反弹待确认，不宜追多';
        tendency = 'UNKNOWN';
        reasons.push(`24h ${fmtPct(chg24)} 偏弱，急拉暂按反弹对待（未突破关键位）`);
      } else if (!up && bull24) {
        // §8.3：不得仅因 24h 偏强就默认洗盘做多——看短线是否转弱
        if (shortDown) {
          caution = '24h 偏强但短线转弱：急跌后持续低位运行，需考虑短线转空而非洗盘';
          tendency = 'UNKNOWN';
        } else {
          caution = '24h 偏强背景下的急杀，若未能有效破位可关注低吸（保守）';
          tendency = 'UNKNOWN';
        }
        reasons.push(`24h ${fmtPct(chg24)} 偏强，急杀方向待确认`);
      } else {
        tendency = 'UNKNOWN';
        reasons.push('方向证据冲突，等待进一步确认');
      }
    } else if (kinds.has('VOLUME_UP') || kinds.has('VOLUME_DOWN')) {
      // §8.6/8.7 放量
      const up = kinds.has('VOLUME_UP');
      const retrace = this.spikeRetraced(ev, snap);
      if (retrace) {
        caution = up ? '放量上涨但价格未能维持高位，冲高回落风险' : '放量下跌后快速收回，等待进一步确认';
        tendency = 'UNKNOWN';
      } else if (boConfirmed) {
        tendency = up ? 'LONG' : 'SHORT';
        reasons.push(`放量且价格有效${up ? '突破' : '跌破'}关键位置`);
      } else {
        tendency = 'UNKNOWN';
        reasons.push('仅放量、暂无明确价格方向/突破支持');
      }
    }

    if (boFalse) {
      tendency = 'UNKNOWN';
      caution = '疑似假突破：价格已回到原区间，不给出方向建议';
      reasons.push('突破有效性丧失');
    }
    if (boPending && tendency !== 'UNKNOWN') {
      reasons.push('突破尚待确认，方向仅作参考');
    }
    if (bull24 && tendency === 'LONG') reasons.push(`24h 背景 ${fmtPct(chg24)} 偏强，与方向一致`);
    if (bear24 && tendency === 'SHORT') reasons.push(`24h 背景 ${fmtPct(chg24)} 偏弱，与方向一致`);
    if ((bull24 && tendency === 'SHORT') || (bear24 && tendency === 'LONG')) {
      reasons.push('短线与 24h 背景冲突，置信度已下调');
    }

    // 置信度：不同类型有效证据相互支持才升级（§九）
    let confirm: ConfirmLevel;
    const supportTypes = new Set<string>();
    if ((dto.dir === 'UP' && kinds.has('SPIKE_UP')) || (dto.dir === 'DOWN' && kinds.has('SPIKE_DOWN'))) supportTypes.add('spike');
    if (kinds.has('VOLUME_UP') || kinds.has('VOLUME_DOWN') || kinds.has('VOLUME_NEUTRAL')) supportTypes.add('volume');
    if (boConfirmed) supportTypes.add('breakout');
    if (tendency === 'LONG' && shortUp) supportTypes.add('structure');
    if (tendency === 'SHORT' && shortDown) supportTypes.add('structure');
    if (tendency === 'UNKNOWN' && (boPending || dto.breakout.status === 'NONE')) confirm = 'PENDING';
    else if (supportTypes.size >= 3) confirm = 'MULTI';
    else if (supportTypes.size === 2) confirm = 'DOUBLE';
    else confirm = 'SINGLE';
    // §六：低流动性提高有效性确认要求——置信度封顶 SINGLE；无层（NONE）不给方向
    if (ctx.tier === 'LOW' && (confirm === 'DOUBLE' || confirm === 'MULTI')) {
      confirm = 'SINGLE';
      reasons.push('低流动性标的：置信度封顶为单一证据');
    }
    if (ctx.tier === 'NONE' && tendency !== 'UNKNOWN') {
      tendency = 'UNKNOWN';
      confirm = 'PENDING';
      reasons.push('行情质量不足（成交额低于监控分层），不输出方向建议');
    }

    dto.direction = { tendency, confirm, reasons, caution };

    // ============ 优先级（§十） ============
    dto.priority = this.priorityOf(dto, confirm, boConfirmed);
    // 历史最高优先级只升不降（冷却池判定：曾达 P1 的事件优先级回落且方向转不明时进入冷却池）
    if (prioValue(dto.priority) < prioValue(dto.peakPriority)) dto.peakPriority = dto.priority;
    this.format(dto);
    void now;
  }

  private priorityOf(dto: EnhancedEventDTO, confirm: ConfirmLevel, boConfirmed: boolean): Priority {
    const hasSpike = dto.evidence.some((e) => e.kind === 'SPIKE_UP' || e.kind === 'SPIKE_DOWN');
    const hasVolume = dto.evidence.some((e) => e.kind === 'VOLUME_UP' || e.kind === 'VOLUME_DOWN');
    // P1：已确认 MAJOR 急拉急跌 / 已确认 MAJOR 有效突破 / 多重印证
    if ((dto.level === 'MAJOR' && hasSpike && confirm !== 'PENDING') || (boConfirmed && confirm !== 'PENDING') || confirm === 'MULTI') {
      return 'P1';
    }
    // P2：MINOR 获第二项证据 / 普通有效突破 / 显著放量且方向明确 / 双重确认的方向
    if (
      (dto.level === 'MINOR' && dto.evidence.length >= 2) ||
      dto.breakout.status === 'CONFIRMED' ||
      (hasVolume && dto.direction.tendency !== 'UNKNOWN') ||
      (dto.direction.tendency !== 'UNKNOWN' && confirm === 'DOUBLE')
    ) {
      return 'P2';
    }
    return 'P3';
  }

  /** 冲高/杀跌回落判定：现价回撤超过事件振幅的一半（§8.2） */
  private spikeRetraced(ev: ActiveEvent, snap: TickSnap): boolean {
    const { dto } = ev;
    const amp = dto.highDuringEvent - dto.lowDuringEvent;
    if (amp <= 0) return false;
    if (dto.dir === 'UP') {
      const drawdown = (dto.highDuringEvent - snap.price) / amp;
      return drawdown > DIRECTION.retraceRatio;
    }
    const recovery = (snap.price - dto.lowDuringEvent) / amp;
    return recovery > DIRECTION.retraceRatio;
  }

  // ============ 事件结束（§7.5） ============

  sweep(now: number): void {
    for (const [key, ev] of this.active) {
      const quietFor = now - ev.lastDetectionAt;
      if (quietFor >= AGG.quietEndMs || now - ev.dto.firstAt >= AGG.maxEventAgeMs) {
        this.endEvent(key, now);
      }
    }
    // ended 为最新在前（endEvent unshift）：超限时从尾部截断，保留「最近」的 400 条。
    // ⚠️ 不能 splice(0, n)（那会删掉队头最新事件、保留最旧 —— 曾导致已结束列表停留在几小时前）
    if (this.ended.length > AGG.maxEventsKept) {
      this.ended.length = AGG.maxEventsKept;
    }
  }

  private endEvent(key: string, now: number): void {
    const ev = this.active.get(key);
    if (!ev) return;
    ev.dto.state = 'ENDED';
    ev.dto.updatedAt = now;
    ev.dto.notify = false;
    this.ended.unshift(ev.dto);
    this.active.delete(key);
  }

  // ============ 通知格式（§十一） ============

  private format(dto: EnhancedEventDTO): void {
    const dirLabel = dto.dir === 'UP' ? '上行异动' : '下行异动';
    const boLabel = formatBreakout(dto);
    dto.headline = `[${dto.level}][${dto.priority}] ${dto.base}/USDT ${dirLabel}`;
    const lines: string[] = [];
    if (dto.chg1m != null || dto.chg5m != null) {
      lines.push(
        `价格变化：${dto.chg1m != null ? `1m ${fmtPct(dto.chg1m)}` : ''}${dto.chg1m != null && dto.chg5m != null ? '，' : ''}${dto.chg5m != null ? `5m ${fmtPct(dto.chg5m)}` : ''}`,
      );
    }
    if (dto.volumeMultiple != null) {
      lines.push(`成交额：过去 20 根 1m 中位数的 ${dto.volumeMultiple.toFixed(1)} 倍`);
    }
    if (dto.breakout.status !== 'NONE') lines.push(`突破状态：${boLabel}`);
    lines.push(`方向倾向：${formatTendency(dto.direction.tendency)}`);
    lines.push(`确认程度：${formatConfirm(dto.direction.confirm)}`);
    if (dto.direction.caution) lines.push(`风险提示：${dto.direction.caution}`);
    lines.push(`触发证据：${[...new Set(dto.evidence.map((e) => e.kind))].join(' + ')}`);
    dto.lines = lines;
  }

  // ============ 查询 ============

  list(now: number): { active: EnhancedEventDTO[]; ended: EnhancedEventDTO[] } {
    void now;
    // 稳定排序：优先级分组 + 同级按首次触发时间升序（队列序）。
    // ⚠️ 不能用 updatedAt 作排序键 —— 事件持续触发期间它每 2s 都在刷新，
    //    会导致列表每次轮询都在重排（跳动）；展示层「变化」改由换池 + 高亮表达。
    const active = [...this.active.values()]
      .map((e) => e.dto)
      .sort((a, b) => prioRank(a) - prioRank(b) || a.firstAt - b.firstAt);
    // ended：最新在前（endEvent unshift），取最近 80 条
    return { active, ended: this.ended.slice(0, 80) };
  }

  counts(): { active: number; ended: number } {
    return { active: this.active.size, ended: this.ended.length };
  }
}

// ============ 纯工具 ============

function evidenceKind(d: Detection): EvidenceKind {
  if (d.detector === 'SPIKE') return d.dir === 'UP' ? 'SPIKE_UP' : 'SPIKE_DOWN';
  if (d.detector === 'VOLUME') {
    return d.dir === 'UP' ? 'VOLUME_UP' : d.dir === 'DOWN' ? 'VOLUME_DOWN' : 'VOLUME_NEUTRAL';
  }
  if (d.level === 'PENDING') return d.dir === 'UP' ? 'BREAKOUT_UP_PENDING' : 'BREAKOUT_DOWN_PENDING';
  return d.dir === 'UP' ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN';
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function formatBreakout(dto: EnhancedEventDTO): string {
  const b = dto.breakout;
  switch (b.status) {
    case 'CONFIRMED':
      return `有效${dto.dir === 'UP' ? '突破 24h 滚动前高' : '跌破 24h 滚动前低'}（${b.via === 'CLOSE' ? '1m 收盘确认' : '连续报价确认'}）`;
    case 'PENDING':
      return '尚未确认有效突破';
    case 'FALSE':
      return '疑似假突破（价格回到区间内）';
    case 'REVIEW':
      return '异常偏离复核中';
    default:
      return '—';
  }
}

function formatTendency(t: Tendency): string {
  return t === 'LONG' ? '偏多' : t === 'SHORT' ? '偏空' : '方向不明';
}

function formatConfirm(c: ConfirmLevel): string {
  switch (c) {
    case 'MULTI':
      return '多重确认';
    case 'DOUBLE':
      return '双重确认';
    case 'SINGLE':
      return '单一证据';
    default:
      return '待确认';
  }
}

function prioValue(p: Priority): number {
  return p === 'P1' ? 0 : p === 'P2' ? 1 : 2;
}

function prioRank(e: EnhancedEventDTO): number {
  return prioValue(e.priority);
}
