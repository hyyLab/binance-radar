/**
 * 两阶段分析提示词（自 PA Agent Web src/lib/pa/prompts.ts 移植——已验证实现，任务书
 * §2「优先复用」；本地化调整仅两处：
 * ① 市场标签固定为币安 U 本位合约；② 15m 背景诊断模式（bg 模式下窗口说明自适应短序列）。
 * 改动本文件必须递增 config.ts 的 PA_PROMPT_VERSION（分析幂等键组成）。
 */
import { featuresToPromptTable, type FeatureBundle } from './indicators';

const CYCLE_STATES = `spike(尖峰: 连续同色大K线, 几乎无回调, 振幅远超ATR)
micro_channel(微型通道: 连续小回调甚至无回调的极强趋势, 大部分K线收在EMA20同侧且不回触)
tight_channel(窄通道: 强趋势+浅回调, 回调不超过1-2根K线, 沿EMA20运行)
normal_channel(正常通道: 趋势明确, 回调2-5根, 回踩EMA20附近常有趋势K线恢复)
broad_channel(宽通道: 趋势方向HH/HL或LL/LH但回调深、双向大K线多, 倾斜的交易区间)
trending_tr(趋势型区间: 区间整体斜率移动, 多数回调较深, 突破常失败)
trading_range(震荡区间: 水平区间, 边界间摆动, 突破后多回入)
extreme_tr(极端区间: 区间极窄, K线高度重叠, 双向都缺乏跟随)
unknown(看不懂: 结构无法归类, 直接触发等待)`;

export interface PaStageMeta {
  symbol: string;
  timeframe: string;
}

/** ── Stage 1 市场诊断（5m 主分析 / 15m 背景共用同一诊断框架） ─────────────────── */

export const STAGE1_SYSTEM = `你是精通 Al Brooks 价格行为体系的交易分析师。阶段一任务：市场诊断（只读懂市场，不产出任何具体价位方案）。

按三层递进完成诊断：
1. 周期频谱定位：判断市场处于以下 8+1 种状态中的哪一种（连续频谱，边界模糊时给 alternative_cycle_position）：
${CYCLE_STATES}
2. 市场背景评估：以较早 K 线为长程窗口，输出 htf_context（背景方向、主要磁力位/结构）。
3. 逐K信号确认：以最近 K 线为即时窗口，判断 Always In 方向（最近8根连续性强弱裁决）、信号棒质量；bar_by_bar_summary 覆盖最近 5 根已收盘 K 线（不足则全覆盖），每条含 bar(如"K3")、role(结构/信号/入场/确认/噪音/陷阱/高潮/测试 之一)、reason(一句话客观事实)。

诊断纪律：
- 只陈述可观察的K线事实，不预测、不写入场/止损/止盈。
- direction 为当前形态下的方向偏好（bullish/bearish/neutral），与 Always In 一致。
- gate_result（诊断闸门）：市场可读且结构可分析 → pass=true；看不懂/极端模糊 → pass=false 并说明。
- diagnosis_confidence 为 0–100 整数。
- support_levels/resistance_levels 给出具体价格水平描述（如"1438.0(近10根低点)"）。

只输出 JSON（无代码块、无多余文本），字段：
{"cycle_position":"...","alternative_cycle_position":null,"direction":"bullish|bearish|neutral","diagnosis_confidence":0-100,"market_phase":"stable|transitioning","support_levels":["..."],"resistance_levels":["..."],"detected_patterns":["..."],"key_signals":["..."],"htf_context":"...","entry_setup":"...(仅描述当前是否存在可评估的入场结构形态，不给价位)","bar_by_bar_summary":[{"bar":"K5","role":"结构","reason":"..."}],"gate_result":{"pass":true,"reason":"..."}}`;

/** 5m 主分析 user 提示词 */
export function buildStage1User(meta: PaStageMeta, fb: FeatureBundle): string {
  const table = featuresToPromptTable(fb.features, 96);
  return `品种: ${meta.symbol}  市场: 币安U本位永续  周期: ${meta.timeframe}
最新价(最近已收盘): ${fb.lastClose}  ATR14: ${fb.lastAtr?.toFixed(4) ?? '-'}  EMA20斜率(近10根): ${fb.emaSlope20?.toFixed(2) ?? '-'}%
K线编号规则: K1=最新已收盘, 数字越大越旧。

逐棒特征表(旧→新):
${table}

请完成阶段一市场诊断，只输出 JSON。`;
}

/** 15m 背景诊断 user 提示词（同一 Stage1 框架，窗口说明按 32 根短序列调整） */
export function buildHtfBackgroundUser(meta: PaStageMeta, fb: FeatureBundle): string {
  const table = featuresToPromptTable(fb.features, 32);
  return `品种: ${meta.symbol}  市场: 币安U本位永续  周期: ${meta.timeframe}（高周期背景诊断，序列共32根）
最新价(最近已收盘): ${fb.lastClose}  ATR14: ${fb.lastAtr?.toFixed(4) ?? '-'}  EMA20斜率(近10根): ${fb.emaSlope20?.toFixed(2) ?? '-'}%
K线编号规则: K1=最新已收盘, 数字越大越旧。本次为高周期背景评估：长程窗口即 K32–K16，重点输出 direction/market_phase/cycle_position/htf_context 与关键磁力位。

逐棒特征表(旧→新):
${table}

请完成阶段一市场诊断，只输出 JSON。`;
}

/** ── Stage 2 交易决策 ──────────────────────────────────────────── */

export const STAGE2_SYSTEM = `你是 Al Brooks 价格行为体系的交易决策官。阶段二任务：基于阶段一诊断输出二元决策树的交易决策。

决策顺序：①市场状态可读？→ ②方向偏好？→ ③入场信号(信号棒/二次入场)？→ ④风险收益(止损/目标/交易者方程)？→ ⑤下单方式(§11)。

四条硬禁令（违反即无效）：
1. 禁止逆势：只顺 stage1.direction / Always In；反转类结构只允许 wait 或顺势回撤方案。
2. 禁止追高潮：诊断提示高潮/尖峰末端(climax)时禁追原方向，只允许回撤顺势或不下单。
3. 禁止仓位管理：不输出手数/比例/分批/移动止损。
4. 成交量仅作可选参考，不构成必要条件。

下单方式枚举：限价单(回调挂单) / 突破单(突破关键位挂单, 须给 entry_basis_bar+entry_basis_extreme+entry_rule) / 市价单(强信号即时) / 不下单。

不变式（必须严格遵守）：
- order_type="不下单" 时：order_direction、entry_price、take_profit_price、take_profit_price_2、stop_loss_price、estimated_win_rate 全部为 null。
- order_type 为三种挂单之一时：上述全部为数值（estimated_win_rate 为 0-100 整数），order_direction 为"做多"或"做空"。
- 止损必须放在结构位（信号棒极值外），目标至少 1 倍风险；交易者方程不合格(胜率*盈亏比不足) → 降级为不下单。

只输出 JSON（无代码块、无多余文本），字段：
{"order_type":"限价单|突破单|市价单|不下单","order_direction":null|"做多"|"做空","entry_price":null|number,"entry_basis_bar":null|"K3","entry_basis_extreme":null|"high"|"low","entry_rule":null|"触发条件说明","take_profit_price":null|number,"take_profit_price_2":null|number,"stop_loss_price":null|number,"reasoning":"≤280字结论","diagnosis_confidence":0-100,"diagnosis_confidence_reasoning":"...","trade_confidence":0-100,"trade_confidence_reasoning":"...","estimated_win_rate":null|0-100,"estimated_win_rate_reasoning":"...","key_factors":["..."],"watch_points":["..."],"risk_assessment":"...","invalidation_condition":"什么情况此方案作废"}`;

export function buildStage2User(
  meta: PaStageMeta,
  fb: FeatureBundle,
  diagnosisJson: string,
): string {
  const recent = featuresToPromptTable(fb.features.slice(-20), 20);
  return `品种: ${meta.symbol}  市场: 币安U本位永续  周期: ${meta.timeframe}
最新价: ${fb.lastClose}  ATR14: ${fb.lastAtr?.toFixed(4) ?? '-'}  EMA20斜率: ${fb.emaSlope20?.toFixed(2) ?? '-'}%

阶段一诊断JSON：
${diagnosisJson}

最近20根特征(旧→新，K1=最新已收盘)：
${recent}

请完成阶段二交易决策，只输出 JSON。`;
}

/** ── JSON 提取兜底（模型偶发包裹代码块/前后缀文字） ───────────── */

export function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出中未找到 JSON');
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    // 宽松修复：去掉行尾逗号
    const fixed = slice.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed) as Record<string, unknown>;
  }
}
