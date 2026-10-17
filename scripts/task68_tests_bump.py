# -*- coding: utf-8 -*-
"""Task 68：测试适配 + 引擎单例 v19→v20（assert 式替换）"""

ROOT = '/home/z/my-project/'


def rep(path, old, new, count=1):
    with open(ROOT + path, encoding='utf-8') as f:
        s = f.read()
    n = s.count(old)
    assert n == count, f'{path}: 期望 {count} 处，实际 {n} 处 —— old 前 60 字: {old[:60]!r}'
    s = s.replace(old, new)
    with open(ROOT + path, 'w', encoding='utf-8') as f:
        f.write(s)
    print(f'OK  {path}: 替换 {count} 处')


# ============ A. strategy-universal-trend.test.ts ============
P = 'tests/trend-trade/strategy-universal-trend.test.ts'

rep(P, '// U6 走弱先走（Task 66 证据达标版）：END_PENDING 证据 ≥2 根才走；1 根 = 单根噪声不割；异周期不误平',
     '// U6 走弱先走（机制保留，注入 WEAKNESS_EXIT_EARLY=true 验证）：END_PENDING 证据 ≥2 根才走；1 根不割；异周期不误平')
rep(P, '''// UE2 硬止损（Task 66）：价格逆行 ≥1.0% → STOP_LOSS；未达线不触发
// UE3 移动止盈（Task 66）：峰值浮盈 ≥15% 激活后回撤 ≥8% → TRAIL_TAKE；未达线不触发''',
     '''// UE2 硬止损（Task 68 长周期定版 1.5%）：价格逆行 ≥1.5% → STOP_LOSS；未达线不触发
// UE3 移动止盈（Task 68 长周期定版 30/20）：峰值浮盈 ≥30% 激活后回撤 ≥20% → TRAIL_TAKE；未达线不触发
// UE4 长周期默认（Task 68）：WEAKNESS_EXIT_EARLY 默认 false——走弱不离场，持有到 ENDED/反向（U6b）''')

rep(P, '''    expect(UNIVERSAL_TREND.STOP_LOSS_PCT).toBe(1.0);
    expect(UNIVERSAL_TREND.TRAIL_ARM_PCT).toBe(15);
    expect(UNIVERSAL_TREND.TRAIL_GIVEBACK_PCT).toBe(8);
    expect(UNIVERSAL_TREND.WEAKNESS_MIN_EVIDENCE_BARS).toBe(2);
    expect(UNIVERSAL_TREND.WEAKNESS_EXIT_EARLY).toBe(true);''',
     '''    expect(UNIVERSAL_TREND.STOP_LOSS_PCT).toBe(1.5); // Task 68：止损住在生命周期容忍带（0.875%）之外
    expect(UNIVERSAL_TREND.TRAIL_ARM_PCT).toBe(30); // Task 68：1.5% 价格兑现过大段才启动保护
    expect(UNIVERSAL_TREND.TRAIL_GIVEBACK_PCT).toBe(20); // Task 68：1% 价格回吐落袋 > 容忍带
    expect(UNIVERSAL_TREND.WEAKNESS_MIN_EVIDENCE_BARS).toBe(2); // 保留（开关重开时生效）
    expect(UNIVERSAL_TREND.WEAKNESS_EXIT_EARLY).toBe(false); // Task 68 长周期：走弱不离场''')

rep(P, '''  test('U6 走弱先走（证据达标版）：END_PENDING 证据 ≥2 根才走；1 根噪声不割；异周期不误平', () => {
    const s = new UniversalTrendStrategy();''',
     '''  test('U6 走弱先走（机制保留，注入开启）：END_PENDING 证据 ≥2 根才走；1 根噪声不割；异周期不误平', () => {
    const s = new UniversalTrendStrategy({ WEAKNESS_EXIT_EARLY: true }); // Task 68 默认 false（长周期），注入开启验证机制''')
rep(P, '      mark: 99.5, // 逆行 0.5% < 止损线 1.0%：隔离走弱维度（止损有 UE2 专测）',
     '      mark: 99.5, // 逆行 0.5% < 止损线 1.5%：隔离走弱维度（止损有 UE2 专测）')

rep(P, '''  test('U6b WEAKNESS_EXIT_EARLY=false：纯持有版，END_PENDING 不离场（等基础设施 ENDED）', () => {
    const s = new UniversalTrendStrategy({ WEAKNESS_EXIT_EARLY: false });''',
     '''  test('U6b 长周期默认（Task 68）：WEAKNESS_EXIT_EARLY=false——END_PENDING 不离场（持有到基础设施 ENDED/反向）', () => {
    const s = new UniversalTrendStrategy(); // 默认即长周期版''')

rep(P, "  test('UE2 硬止损：价格逆行 ≥1.0%（价格口径）→ STOP_LOSS；未达线不触发', () => {",
     "  test('UE2 硬止损：价格逆行 ≥1.5%（Task 68 长周期定版，价格口径）→ STOP_LOSS；未达线不触发', () => {")
rep(P, '''    // 逆行 1.2% ≥ 1.0% → 止损（20x 下 = 24% 保证金回撤即砍，不拖到强平）
    const loss = s.evaluateExit({ ...base, mark: 98.8, now: Date.now() });''',
     '''    // 逆行 1.8% ≥ 1.5% → 止损（20x 下 = 36% 保证金回撤即砍，不拖到强平）
    const loss = s.evaluateExit({ ...base, mark: 98.2, now: Date.now() });''')
rep(P, '''    // 逆行 0.8% < 1.0%（常态 ATR 级回调）→ 不止损（容忍正常波动，不「稍微回调就割」）
    const ok = s.evaluateExit({ ...base, mark: 99.2, now: Date.now() });''',
     '''    // 逆行 1.2% < 1.5%（介于生命周期容忍带 0.875% 与止损线之间）→ 不止损（给趋势呼吸空间）
    const ok = s.evaluateExit({ ...base, mark: 98.8, now: Date.now() });''')
rep(P, '    // SHORT 对称：entry 100 逆行到 101.2（+1.2%）→ 止损',
     '    // SHORT 对称：entry 100 逆行到 101.8（+1.8%）→ 止损')
rep(P, '      mark: 101.2, signal: null, now: Date.now(),',
     '      mark: 101.8, signal: null, now: Date.now(),')

rep(P, "  test('UE3 移动止盈：峰值浮盈 ≥15% 激活后回撤 ≥8% → TRAIL_TAKE；未达线不触发', () => {",
     "  test('UE3 移动止盈：峰值浮盈 ≥30% 激活后回撤 ≥20% → TRAIL_TAKE；未达线不触发（Task 68 长周期 30/20）', () => {")
rep(P, '''    // DB 统计的持仓期峰值 MFE=25%（保证金口径）→ 已激活
    const m = { ...meta('BTCUSDT', cycle), mfe: 25 } as unknown as TrendTradeMetaRow;''',
     '''    // 持仓期峰值 MFE=40%（保证金口径 = 2% 价格 @20x）→ 已激活
    const m = { ...meta('BTCUSDT', cycle), mfe: 40 } as unknown as TrendTradeMetaRow;''')
rep(P, '''    // 当前浮盈 15%：回撤 25-15=10 ≥ 8 → 落袋（保住 ≥15% 利润）
    const take = s.evaluateExit({
      meta: m, pos, mark: 100.75,''',
     '''    // 当前浮盈 18%：回撤 40-18=22 ≥ 20 → 落袋（保住 ≥18% 利润）
    const take = s.evaluateExit({
      meta: m, pos, mark: 100.9,''')
rep(P, '''    // 当前浮盈 22%：回撤 3 < 8 → 继续拿（趋势模型的「确认在就拿大段」不被小回撤打扰）
    const hold = s.evaluateExit({
      meta: m, pos, mark: 101.1,''',
     '''    // 当前浮盈 32%：回撤 8 < 20 → 继续拿（趋势内正常回调不打断长周期持仓）
    const hold = s.evaluateExit({
      meta: m, pos, mark: 101.6,''')
rep(P, '    // 未激活：MFE 只有 10%（< 15% 激活线）→ 即便当前回撤大也不触发（没有利润可保护）',
     '    // 未激活：MFE 只有 10%（< 30% 激活线）→ 即便当前回撤大也不触发（没有利润可保护）')

# ============ B. strategy-short-swing.test.ts ============
P = 'tests/trend-trade/strategy-short-swing.test.ts'

rep(P, '// S7 轮次：同周期再入场需新收盘 K 线 + 上限（默认 1 = 只做第一波，Task 66 顺势化）+ 新周期重置',
     '// S7 轮次：同周期再入场需新收盘 K 线 + 上限（注入 2 验证机制）+ 新周期重置（Task 68 默认 2）')
rep(P, '// S11 确认新鲜窗（Task 66）：确认已走老 → 拒绝（只做方向刚走强的第一时间顺势单）',
     '''// S11 确认新鲜窗（Task 68 仅约束首轮 R1）：确认已走老的首轮 → 拒绝
// S12 新鲜窗仅约束首轮（Task 68）：同周期 R2 再入场不受确认年龄限制''')

rep(P, '''  test('S7c 默认轮次=1（Task 66 顺势化）：同周期走弱离场后不再进（有新 K 线也不进）', () => {
    const s = new ShortSwingStrategy(); // 默认 MAX_ROUNDS_PER_CYCLE=1''',
     '''  test('S7c 默认轮次=2（Task 68 再入场解禁）：走弱离场后走强回确认 + 新 K 线 → #R2 再入场', () => {
    const s = new ShortSwingStrategy(); // 默认 MAX_ROUNDS_PER_CYCLE=2''')
rep(P, '''    expect(v2.want).toBe(false);
    expect(v2.reason).toContain('轮次已用尽');
  });''',
     '''    expect(v2.want).toBe(true); // 用户 2026-10-18：不强制只做第一顺势单（第一单胜率更高，按时间顺序天然先做）
    expect(v2.reason).toContain('#R2');
  });''', count=1)

rep(P, "  test('S11 确认新鲜窗（Task 66）：确认已走老 → 拒绝（只做方向刚走强的第一时间顺势单）', () => {",
     "  test('S11 确认新鲜窗（Task 68 仅约束首轮 R1）：首轮确认已走老 → 拒绝', () => {")

rep(P, '''    // 新鲜确认（默认 fixture 15 秒前）→ 放行
    const vFresh = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 80, er: 0.5 }), ctx());
    expect(vFresh.want).toBe(true);
  });''',
     '''    // 新鲜确认（默认 fixture 15 秒前）→ 放行
    const vFresh = s.evaluateEntry(sig({ phase: 'CONFIRMED_UP', score: 80, er: 0.5 }), ctx());
    expect(vFresh.want).toBe(true);
  });

  test('S12 新鲜窗仅约束首轮（Task 68）：同周期 R2 再入场不受确认年龄限制', () => {
    const s = new ShortSwingStrategy();
    const cyc = 'BTCUSDT:L:100';
    // 首轮开仓后走弱离场（时间回拨避开再入场间隔检查）
    s.onOpen('BTCUSDT', cyc, 1000, Date.now());
    s.onClose('BTCUSDT', cyc, 'WEAKNESS_EARLY', Date.now() - 120_000);
    // 确认发生在 6 分钟前（> ENTRY_FRESH_MS 180s）——若新鲜窗约束 R2 将被 STALE_CONFIRM 拒绝
    const v = s.evaluateEntry(
      sig({
        phase: 'CONFIRMED_UP', cycleId: cyc, lastBarTime: 5000, // 新收盘 K 线（重新走强证据）
        startedAtMs: Date.now() - 360_000,
      }),
      ctx(),
    );
    expect(v.want).toBe(true); // R2 的新鲜度由「重新走强」事件自身定义，不受周期年龄约束
    expect(v.reason).toContain('#R2');
  });''')

rep(P, "  test('S9 默认参数未校准声明：关键阈值与文档一致（Task 66 顺势化后）', () => {",
     "  test('S9 默认参数未校准声明：关键阈值与文档一致（Task 68 后）', () => {")
rep(P, '    expect(SHORT_SWING.MAX_ROUNDS_PER_CYCLE).toBe(1); // Task 66：只做第一波',
     '    expect(SHORT_SWING.MAX_ROUNDS_PER_CYCLE).toBe(2); // Task 68：不强制只做第一波（走弱后走强可 R2）')
rep(P, '    expect(SHORT_SWING.ENTRY_FRESH_MS).toBe(180_000); // Task 66：确认新鲜窗',
     '    expect(SHORT_SWING.ENTRY_FRESH_MS).toBe(180_000); // Task 68：确认新鲜窗仅约束首轮（R1）')

# ============ C. auto-trader.test.ts ============
P = 'tests/trend-trade/auto-trader.test.ts'

rep(P, '''  test('T4c 默认轮次=1（Task 66 顺势化）：同周期走弱离场后不再进（有新 K 线也不建待入场）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:843' })];
    const trader = makeTrader(signals, engine, new ShortSwingStrategy({ REENTRY_MIN_GAP_MS: 0 }));''',
     '''  test('T4c 轮次用尽（注入 MAX_ROUNDS_PER_CYCLE=1）：同周期走弱离场后不再进（有新 K 线也不建待入场）', async () => {
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    const signals = [sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:843' })];
    const trader = makeTrader(
      signals,
      engine,
      new ShortSwingStrategy({ REENTRY_MIN_GAP_MS: 0, MAX_ROUNDS_PER_CYCLE: 1 }), // 注入 1 轮验证用尽路径
    );''')
rep(P, '    // 走强回确认 + 新 K 线 + 冷却已过——但默认 MAX_ROUNDS_PER_CYCLE=1 → 不再进（R2 被顺势定版关闭）',
     '    // 走强回确认 + 新 K 线 + 冷却已过——但轮次已用尽（注入 MAX_ROUNDS_PER_CYCLE=1）→ 不再进')
rep(P, '''      // 默认策略思路（走弱先走）；REENTRY_MIN_GAP_MS=0：真实时钟不可快进，60s 间隔已由
      // 策略单元测试 S7b 覆盖，这里聚焦轮次化决策键与再入场全链路。
      // Task 66：MAX_ROUNDS_PER_CYCLE 默认改 1（只做第一波）——本用例测 R2 机制需显式开 2 轮
      new ShortSwingStrategy({ REENTRY_MIN_GAP_MS: 0, MAX_ROUNDS_PER_CYCLE: 2 }),''',
     '''      // 默认策略思路（走弱先走）；REENTRY_MIN_GAP_MS=0：真实时钟不可快进，60s 间隔已由
      // 策略单元测试 S7b 覆盖，这里聚焦轮次化决策键与再入场全链路。
      // Task 68：MAX_ROUNDS_PER_CYCLE 默认 2（不强制只做第一波）——R2 全链路按默认参数验证
      new ShortSwingStrategy({ REENTRY_MIN_GAP_MS: 0 }),''')

# ============ D. engine.ts 单例 bump v19→v20 ============
P = 'src/lib/market/enhanced/engine.ts'

rep(P, '// v19（Task 67）：仓位划分按配置舱位数——用户复盘「选两舱但 1 仓占 95 成保证金」判定',
     '''// v20（Task 68）：两算法二轮定版——①通用趋势引擎长周期化（用户「持仓时间太短，它是长周期
//   模型」）：WEAKNESS_EXIT_EARLY 默认 false（走弱迹象不离场，持有到 ENDED/反向）、硬止损
//   1.0→1.5%（住进生命周期容忍带 0.875% 之外）、移动止盈 15/8→30/20（1.5% 价格启动保护 /
//   1.0% 回吐落袋，净锁利 ≥10% 保证金）；②短周期套利再入场解禁（用户「没强制只做第一
//   顺势单，只是它胜率更高」）：MAX_ROUNDS_PER_CYCLE 1→2、确认新鲜窗仅约束首轮 R1（R2 的
//   新鲜度由「重新走强」事件自身定义）。strategyParamsJson 当前为空（代码默认即生效值）。
//   改行为必 bump key。
// v19（Task 67）：仓位划分按配置舱位数——用户复盘「选两舱但 1 仓占 95 成保证金」判定''')

rep(P, '  __binanceRadarEnhanced_v19?: EnhancedEngine; // v19（Task 67）：仓位划分按配置舱位数（1 舱满配 95%、N 舱各 95%/N）',
     '''  __binanceRadarEnhanced_v19?: EnhancedEngine; // v19（Task 67）：仓位划分按配置舱位数（1 舱满配 95%、N 舱各 95%/N）
  __binanceRadarEnhanced_v20?: EnhancedEngine; // v20（Task 68）：UTE 长周期化 + short-swing 再入场解禁''')

rep(P, '''    __binanceRadarEnhanced_v18?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''',
     '''    __binanceRadarEnhanced_v18?: EnhancedEngine;
    __binanceRadarEnhanced_v19?: EnhancedEngine;
    __binanceRadarEnhanced_v20?: EnhancedEngine;
  },
): EnhancedEngine | undefined {''')

rep(P, '''  return (
    g.__binanceRadarEnhanced_v18 ??''',
     '''  return (
    g.__binanceRadarEnhanced_v20 ??
    g.__binanceRadarEnhanced_v19 ??
    g.__binanceRadarEnhanced_v18 ??''')

rep(P, '  const existing = g.__binanceRadarEnhanced_v19;', '  const existing = g.__binanceRadarEnhanced_v20;')
rep(P, '''  g.__binanceRadarEnhanced_v19 = fresh;
  return fresh;
}''', '''  g.__binanceRadarEnhanced_v20 = fresh;
  return fresh;
}''', count=2)
rep(P, '  const old = g.__binanceRadarEnhanced_v19 ?? pickLegacyEngine(g);',
     '  const old = g.__binanceRadarEnhanced_v20 ?? pickLegacyEngine(g);')

print('== 测试适配 + 单例 bump 全部落盘 ==')
