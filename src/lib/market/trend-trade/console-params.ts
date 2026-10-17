// ---------- 趋势自动交易 · 参数控制台元数据（Task 57-c 用户定版） ----------
// 用户要求：提供一个控制台，可自行更改自动开仓参数，并配说明书标注每个参数含义。
// 本文件是控制台的唯一数据源：
//   - PARAM_DEFS  ：全部可调参数的定义（分组/类型/范围/默认值/含义文案——UI 与说明书共用）
//   - sanitizeRuntimeParams()：control API 的入参校验（白名单键 + 类型 + 范围，拒绝即 400）
//   - effectiveRuntimeParams()：合并「代码默认 + DB 覆盖」得到当前生效值（overview 展示）
//
// 纪律：
// - 参数分两域：strategy（当前策略的覆盖项，按 strategyId 存 DB；每个 ParamDef 标注
//   strategyId 归属——Task 62 多算法时代：通用趋势引擎 universal-trend-v1 暂用代码默认
//   参数未注册 DEFS，控制台只展示「属于当前算法」的参数，跨策略键一律拒绝/丢弃）
//   与 infra（开仓节奏基础设施：二次确认开关/冷却——AutoPaperTrader 消费）。
// - 校验失败绝不静默修正：返回错误让用户看到原因（调参是明确的人为意图）。
// - 未在 DEFS 中的键一律拒绝（防止拼错键名造成「看起来生效了」的错觉）。

import { TREND_TRADE } from './config';
import { SHORT_SWING, type ShortSwingParams } from './strategy/short-swing';

/** 解析 DB strategyParamsJson（{ [strategyId]: 覆盖项 }；损坏/格式不对返回空 map——参数回退代码默认） */
export function parseStrategyParamsMap(
  json: string | null | undefined,
): Record<string, Record<string, unknown>> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return v as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

/** 单个可调参数的定义（UI 渲染 + 校验范围 + 说明书文案三合一） */
export interface ParamDef {
  /** 参数键（strategy 域 = SHORT_SWING 键；infra 域 = waitBarConfirm/cooldownMs） */
  key: string;
  /** 域：strategy = 策略参数（随算法走，按 strategyId 持久化）；infra = 基础设施参数（全局） */
  scope: 'strategy' | 'infra';
  /** 控制台分组标题（按顺序渲染） */
  group: string;
  /** 显示名 */
  label: string;
  type: 'number' | 'boolean';
  /** 默认值（number 或 boolean） */
  default: number | boolean;
  /** number 类型的合法范围与步进 */
  min?: number;
  max?: number;
  step?: number;
  /** 单位（显示用，如 %、ms、秒） */
  unit?: string;
  /** 一句话含义（UI 说明行 / 说明书正文共用） */
  desc: string;
  /** strategy 域参数的归属策略 id（infra 域不设）；控制台/校验按当前算法过滤（Task 62） */
  strategyId?: string;
  /** 调大/调小的效果（说明书速查表与 UI 悬浮提示用） */
  effect?: string;
}

/** 控制台全部参数定义（顺序 = UI 渲染顺序；分组连续排列） */
export const PARAM_DEFS: ParamDef[] = [
  // ===== A · 入场门槛（模式 A：5m 同向 → 趋势内波段） =====
  {
    key: 'ENTRY_MIN_SCORE', scope: 'strategy', strategyId: 'short-swing-v1', group: '入场门槛 · 模式A（5m 同向波段）',
    label: '评分下限', type: 'number', default: SHORT_SWING.ENTRY_MIN_SCORE,
    min: 0, max: 100, step: 1,
    desc: '1m 趋势评分（0-100 证据分）达到该值才允许模式 A 入场。趋势起点分数不高（高分≈走势已走出来），本门槛只挡「证据不足的杂音」。',
    effect: '调低 → 更早入场、交易更多，杂音单变多；调高 → 只做已走稳的趋势，起点单被放弃',
  },
  {
    key: 'ENTRY_MIN_ER', scope: 'strategy', strategyId: 'short-swing-v1', group: '入场门槛 · 模式A（5m 同向波段）',
    label: '效率比(ER)下限', type: 'number', default: SHORT_SWING.ENTRY_MIN_ER,
    min: 0, max: 1, step: 0.01,
    desc: '1m 效率比 = 净位移/路径总长，衡量走势「直不直」。低于该值视为震荡结构，即使评分够也不入场（防磨损的核心护栏，与入场早晚正交）。',
    effect: '调低 → 接受更抖的结构、单量增加；调高 → 只做干净单边，震荡频繁时少亏手续费',
  },
  // ===== B · 入场门槛（模式 B：5m 震荡 → 短周期选向） =====
  {
    key: 'NEUTRAL_MIN_SCORE', scope: 'strategy', strategyId: 'short-swing-v1', group: '入场门槛 · 模式B（5m 震荡选向）',
    label: '评分下限', type: 'number', default: SHORT_SWING.NEUTRAL_MIN_SCORE,
    min: 0, max: 100, step: 1,
    desc: '5m 背景震荡（或数据不足）时，1m 率先确认的方向即交易方向；因缺少 5m 背景背书，评分要求比模式 A 严一档。',
    effect: '调低 → 震荡中更早抢方向、假突破风险变大；调高 → 只做证据更强的突破，起步单减少',
  },
  {
    key: 'NEUTRAL_MIN_ER', scope: 'strategy', strategyId: 'short-swing-v1', group: '入场门槛 · 模式B（5m 震荡选向）',
    label: '效率比(ER)下限', type: 'number', default: SHORT_SWING.NEUTRAL_MIN_ER,
    min: 0, max: 1, step: 0.01,
    desc: '模式 B 的 ER 要求（比模式 A 严）：震荡中选向，对「起步结构干净度」要求更高，防止把震荡噪声当成方向。',
    effect: '调低 → 更早入场但易接假突破；调高 → 模式 B 接近只在干净突破时才开',
  },
  // ===== C · 入场时机（滞后调节） =====
  {
    key: 'waitBarConfirm', scope: 'infra', group: '入场时机（滞后调节）',
    label: '等待下一根收盘K线二次确认', type: 'boolean', default: true,
    desc: '开：策略想开仓后先记「待入场」，等下一根已收盘 K 线复核仍达标才真正开仓（多等 1 根，防一根 K 线的噪声/插针）。关：达标当根即直接开仓（快 1 根 K 线，少一层防护）。1m 趋势确认本身固定需要 3 根已收盘 K 线，本开关只影响确认之后的等待。',
    effect: '关 = 入场快约 1 根 K 线，但假信号直接进场；开 = 慢 1 根，进场质量更高（默认开）',
  },
  {
    key: 'REENTRY_MIN_GAP_MS', scope: 'strategy', strategyId: 'short-swing-v1', group: '入场时机（滞后调节）',
    label: '同周期再入场最小间隔', type: 'number', default: SHORT_SWING.REENTRY_MIN_GAP_MS,
    min: 0, max: 600_000, step: 10_000, unit: 'ms',
    desc: '同一趋势周期内，上次平仓到下次再入场（走强回确认）的最小间隔，防止同一根 K 线内反复进出打手续费。',
    effect: '调小 → 走强后更快接回；调大 → 强制多等，减少高频进出磨损',
  },
  // ===== D · 再入场与轮次 =====
  {
    key: 'MAX_ROUNDS_PER_CYCLE', scope: 'strategy', strategyId: 'short-swing-v1', group: '再入场与轮次',
    label: '同周期最大开仓轮次', type: 'number', default: SHORT_SWING.MAX_ROUNDS_PER_CYCLE,
    min: 1, max: 6, step: 1, unit: '轮',
    desc: '同一趋势周期最多开仓几次（首次 + 走弱后走强的再入场；轮次键 #R1/#R2…）。防单周期无限磨损的上限。',
    effect: '调大 → 同一趋势里反复进出机会更多；调小/1 → 每个周期只做第一笔',
  },
  {
    key: 'WEAKNESS_EXIT_EARLY', scope: 'strategy', strategyId: 'short-swing-v1', group: '再入场与轮次',
    label: '走弱提前离场', type: 'boolean', default: SHORT_SWING.WEAKNESS_EXIT_EARLY,
    desc: '开：本周期出现结束迹象（END_PENDING）即先离场，走强回确认后按轮次再入场。关：忽略走弱迹象，等趋势正式判定结束（ENDED）才离场——持仓更连续，但回撤可能更深。',
    effect: '关 = 拿得住、回撤大；开 = 回撤小、可能被洗出后再入场多付一次手续费（默认开）',
  },
  // ===== E · 冲高套利（离场） =====
  {
    key: 'SPIKE_MOVE_PCT', scope: 'strategy', strategyId: 'short-swing-v1', group: '冲高套利（及时落袋）',
    label: '冲高幅度阈值', type: 'number', default: SHORT_SWING.SPIKE_MOVE_PCT,
    min: 0.1, max: 5, step: 0.05, unit: '%',
    desc: '持仓浮盈时，检测窗口内标记价顺持仓方向快速运动 ≥ 该幅度 → 立即落袋（SPIKE_TAKE）。针对虚拟币冲高回落/下杀拉回的行为模式，是价格行为离场、不是固定比例止盈。',
    effect: '调低 → 小冲高就走、落袋更频繁；调高 → 拿更大的波段、可能错过快速回落前的出场窗口',
  },
  {
    key: 'SPIKE_WINDOW_MS', scope: 'strategy', strategyId: 'short-swing-v1', group: '冲高套利（及时落袋）',
    label: '冲高检测窗口', type: 'number', default: SHORT_SWING.SPIKE_WINDOW_MS,
    min: 30_000, max: 300_000, step: 10_000, unit: 'ms',
    desc: '判断「正在冲高/下杀」的回看窗口：窗口内顺向运动幅度达到阈值即触发。窗口越短对「急拉急砸」越敏感。',
    effect: '调小 → 只响应极快的脉冲；调大 → 缓慢拉升也会触发（但也更容易在趋势中段提前下车）',
  },
  {
    key: 'SPIKE_MIN_HOLD_MS', scope: 'strategy', strategyId: 'short-swing-v1', group: '冲高套利（及时落袋）',
    label: '最短持仓时间', type: 'number', default: SHORT_SWING.SPIKE_MIN_HOLD_MS,
    min: 0, max: 300_000, step: 5_000, unit: 'ms',
    desc: '开仓后至少持仓该时长才允许冲高套利触发——防开仓瞬间的样本噪声立刻把自己洗出去。',
    effect: '调大 → 刚开仓的前几十秒不触发落袋；调小 → 更灵敏但易被开仓初期噪声洗出',
  },
  // ===== F · 方向约束 =====
  {
    key: 'ALLOW_HTF_OPPOSED', scope: 'strategy', strategyId: 'short-swing-v1', group: '方向约束',
    label: '允许逆 5m 背景开仓', type: 'boolean', default: SHORT_SWING.ALLOW_HTF_OPPOSED,
    desc: '开：1m 方向与 5m 背景相反时也允许入场（真正的纯短周期博弈）。关：5m 反向一律拒绝（不做逆势，用户定版默认）。',
    effect: '开 = 单量变多但胜率结构变差（逆势单）；默认关——短周期套利不做逆势',
  },
  // ===== G · 节奏（基础设施） =====
  {
    key: 'cooldownMs', scope: 'infra', group: '节奏（基础设施）',
    label: '同币种平仓后冷却', type: 'number', default: TREND_TRADE.COOLDOWN_MS,
    min: 0, max: 30 * 60_000, step: 30_000, unit: 'ms',
    desc: '同一币种平仓后该时长内新信号只记录不执行，到期后重走完整门槛。防止同一波行情刚平仓又立刻反向追。',
    effect: '调小 → 平仓后更快允许再进；0 = 无冷却（磨损风险自担）；调大 → 更保守',
  },
  // ===== H · 仓位与资金（基础设施；Task 58） =====
  {
    key: 'marginRatio', scope: 'infra', group: '仓位与资金（基础设施）',
    label: '每仓保证金比例', type: 'number', default: TREND_TRADE.MARGIN_RATIO,
    min: 0.01, max: 1, step: 0.05,
    desc: '每仓保证金占比上限。实际生效 = min(本上限, 95% ÷ (当前持仓数+1))——单一持仓时自动用满 95% 配额开最大仓位（Task 65 用户定版），并发持仓越多单仓自动越小（第 2 仓 47.5%、第 3 仓 31.7%…动态槽位均分）。要同时开满 N 仓，把本值调到 ≤ 95%/N（如 8 仓 ≈ 0.12）。保证金 + 手续费超出可用余额时跳过并记录，不变通。',
    effect: '调大 → 单仓更大（95% 配额内）；0.95 = 单仓满配、并发仓几乎开不出（等前一仓平仓后滚动开大仓）；调小 → 单仓更轻、可并发的仓数更多',
  },
];

/** 键 → 定义索引（校验/合并用） */
const DEF_BY_KEY = new Map(PARAM_DEFS.map((d) => [d.key, d]));

export interface RuntimeParamValue {
  key: string;
  scope: 'strategy' | 'infra';
  group: string;
  label: string;
  type: 'number' | 'boolean';
  value: number | boolean;
  default: number | boolean;
  overridden: boolean;
  unit?: string;
  /** number 型合法范围（UI 输入校验/提示用） */
  min?: number;
  max?: number;
  desc: string;
  effect?: string;
}

/** 代码默认值（strategy 域 = SHORT_SWING；infra 域 = TREND_TRADE 常量） */
function codeDefault(d: ParamDef): number | boolean {
  return d.default;
}

/**
 * 合并出当前生效值（overview 控制台数据源）。
 * overridden 语义 = 当前值 ≠ 代码默认（而非「DB 里存过键」——控制台全量保存后
 * 与默认同值的键不算自定义，避免徽标噪音）。
 * @param strategyOverrides 当前策略的覆盖项（DB strategyParamsJson → map[strategyId]）
 * @param infra 当前基础设施列值（{ waitBarConfirm, cooldownMs }；null = 未设过用默认）
 */
export function effectiveRuntimeParams(
  strategyId: string,
  strategyOverrides: Record<string, unknown> | null,
  infra: { waitBarConfirm?: number | null; cooldownMs?: number | null; marginRatio?: number | null },
): RuntimeParamValue[] {
  // Task 62：strategy 域参数只展示「属于当前算法」的条目（如 universal-trend-v1 暂未
  // 注册 DEFS → strategy 域为空，控制台仅剩 infra 组——代码默认即生效，无调参入口）；
  // infra 域参数全局共享，不受算法切换影响。
  return PARAM_DEFS
    .filter((d) => d.scope === 'infra' || d.strategyId === strategyId)
    .map((d) => {
      let value = codeDefault(d);
      if (d.scope === 'strategy') {
        const v = strategyOverrides?.[d.key];
        if (v !== undefined) value = v as number | boolean;
      } else if (d.key === 'waitBarConfirm') {
        value = infra.waitBarConfirm != null ? infra.waitBarConfirm !== 0 : true;
      } else if (d.key === 'cooldownMs') {
        if (infra.cooldownMs != null) value = infra.cooldownMs;
      } else if (d.key === 'marginRatio') {
        if (infra.marginRatio != null) value = infra.marginRatio;
      }
      const overridden = value !== codeDefault(d);
      return {
        key: d.key, scope: d.scope, group: d.group, label: d.label, type: d.type,
        value, default: codeDefault(d), overridden, unit: d.unit,
        min: d.min, max: d.max, desc: d.desc, effect: d.effect,
      };
    });
}

/**
 * 宽松校验（DB 读路径专用，如 applyStrategy 装配参数时）：逐键校验，
 * 非法键/值直接丢弃（回退该键的代码默认），绝不因脏数据阻断交易循环。
 * 写路径（control API）用严格版 sanitizeRuntimeParams——用户调参错误必须可见。
 */
export function sanitizeRuntimeParamsLenient(
  raw: unknown,
  strategyId: string,
): { strategyParams: Record<string, unknown>; waitBarConfirm?: number; cooldownMs?: number; marginRatio?: number } {
  const out: { strategyParams: Record<string, unknown>; waitBarConfirm?: number; cooldownMs?: number; marginRatio?: number } = {
    strategyParams: {},
  };
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const def = DEF_BY_KEY.get(key);
    if (!def) continue;
    if (def.type === 'number') {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) continue;
      if (def.min != null && n < def.min) continue;
      if (def.max != null && n > def.max) continue;
      if (def.scope === 'strategy' && def.strategyId === strategyId) (out.strategyParams as Record<string, number>)[key] = n;
      else if (key === 'cooldownMs') out.cooldownMs = Math.round(n);
      else if (key === 'marginRatio') out.marginRatio = n;
    } else {
      if (typeof value !== 'boolean') continue;
      if (def.scope === 'strategy' && def.strategyId === strategyId) (out.strategyParams as Record<string, boolean>)[key] = value;
      else if (key === 'waitBarConfirm') out.waitBarConfirm = value ? 1 : 0;
    }
  }
  return out;
}

/**
 * control API 入参校验（白名单 + 类型 + 范围）。任何非法键/值都抛错（400 返回给用户），
 * 绝不静默丢弃——用户调参是明确意图，错配必须可见。
 */
export interface SanitizedRuntimeParams {
  /** 策略域覆盖项（干净、仅含合法键——存什么用什么） */
  strategyParams: ShortSwingParams;
  waitBarConfirm?: number;
  cooldownMs?: number;
  /** 每仓保证金比例（Task 58；TrendAutoConfig.marginRatio 列，NOT NULL DEFAULT 0.2） */
  marginRatio?: number;
}

export function sanitizeRuntimeParams(raw: unknown, strategyId: string): SanitizedRuntimeParams {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('参数格式错误：应为 { 键: 值 } 对象');
  }
  const out: SanitizedRuntimeParams = { strategyParams: {} };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) throw new Error('未提供任何参数');
  for (const [key, value] of entries) {
    const def = DEF_BY_KEY.get(key);
    if (!def) throw new Error(`未知参数：${key}（可在控制台查看全部可调参数）`);
    if (def.scope === 'strategy' && def.strategyId !== strategyId) {
      throw new Error(`参数 ${key} 不属于当前算法（${strategyId}），请刷新控制台后重试`);
    }
    if (def.type === 'number') {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new Error(`${def.label}（${key}）须为数字，收到：${JSON.stringify(value)}`);
      }
      if (def.min != null && n < def.min) throw new Error(`${def.label}（${key}）不能低于 ${def.min}${def.unit ?? ''}`);
      if (def.max != null && n > def.max) throw new Error(`${def.label}（${key}）不能超过 ${def.max}${def.unit ?? ''}`);
      if (def.scope === 'strategy') (out.strategyParams as Record<string, number>)[key] = n; // 归属已在上面校验
      else if (key === 'cooldownMs') out.cooldownMs = Math.round(n);
      else if (key === 'marginRatio') out.marginRatio = n;
    } else {
      if (typeof value !== 'boolean') {
        throw new Error(`${def.label}（${key}）须为 true/false`);
      }
      if (def.scope === 'strategy') (out.strategyParams as Record<string, boolean>)[key] = value;
      else if (key === 'waitBarConfirm') out.waitBarConfirm = value ? 1 : 0;
    }
  }
  return out;
}
