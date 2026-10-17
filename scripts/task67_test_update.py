#!/usr/bin/env python3
# Task 67：测试文件更新——舱位划分语义（按配置舱位数 95%÷N）替换 Task 65 动态槽位语义（95%÷(当前持仓数+1)）
# 环境已知中文漂移问题 → 对策：行号定位 + ASCII 子串断言，中文字面量绝不参与匹配；
# 自底向上替换保证行号不位移；每处 assert 失败即中止不写盘。
import pathlib

P = pathlib.Path('/home/z/my-project/tests/trend-trade/auto-trader.test.ts')
lines = P.read_text(encoding='utf-8').split('\n')  # 0-based; 文件第 N 行 = lines[N-1]

def assert_contains(ln, needle):  # ln: 1-based
    s = lines[ln - 1]
    assert needle in s, f'line {ln} missing {needle!r}: {s[:90]!r}'

def set_line(ln, text, expect):
    assert_contains(ln, expect)
    lines[ln - 1] = text

# ===== 自底向上 =====
# 注：L4/L356/L369/L651 已由先前 Edit 落盘（MultiEdit 报错但前序编辑已生效），不再重复处理

# L1339：T34 注释（值不变：cap 0.1 低于任何舱位线）
set_line(1339,
  '    // sizing 生效：maxPositions=3 → min(10%, 95%/3≈31.7%)=10% → margin = floor2(100 × 0.1) = 10.00',
  'slot=1')

# T29a 块 1198-1214 → 新配额表（边界：1216 行 = test('T29 ）
assert_contains(1198, "test('T29a")
assert_contains(1198, 'Task 65')
assert lines[1213].strip() == '});', repr(lines[1213])
assert_contains(1216, "test('T29 ")
T29A = '''  test('T29a effectiveMarginRatio 舱位配额表（Task 67）：按配置舱位数划分——1 舱满配 95%，N 舱各 95%/N，上限封顶始终生效', () => {
    // 1 舱：min(cap, 95%)——cap=0.95 即满配开最大仓（用户定版）
    expect(effectiveMarginRatio(0.95, 1)).toBe(0.95);
    expect(effectiveMarginRatio(0.2, 1)).toBe(0.2); // 低上限原样生效
    // 舱位递减：N 舱各 95%÷N（划分只看配置舱位数，与当前持仓数无关）
    expect(effectiveMarginRatio(0.95, 2)).toBeCloseTo(0.475, 10); // 2 舱各 47.5%
    expect(effectiveMarginRatio(0.95, 3)).toBeCloseTo(0.95 / 3, 10); // 3 舱各 31.7%
    expect(effectiveMarginRatio(0.95, 4)).toBeCloseTo(0.2375, 10); // 4 舱各 23.75%
    expect(effectiveMarginRatio(0.95, 8)).toBeCloseTo(0.11875, 10); // 8 舱各 11.875%
    // 上限低于舱位线：用户值生效
    expect(effectiveMarginRatio(0.1, 2)).toBe(0.1);
    expect(effectiveMarginRatio(0.1, 8)).toBe(0.1);
    // 防御：0/负数/小数/NaN 按单舱满配处理（绝不放大比例）
    expect(effectiveMarginRatio(0.95, 0)).toBe(0.95);
    expect(effectiveMarginRatio(0.95, -3)).toBe(0.95);
    expect(effectiveMarginRatio(0.95, NaN)).toBe(0.95);
    expect(effectiveMarginRatio(0.95, 2.7)).toBeCloseTo(0.475, 10); // floor→2 舱
  });'''
lines[1197:1214] = T29A.split('\n')

# L918 / L729：同一注释两处（默认 0.95 时两仓配额 47.5% 可开出，钉 20% 只为隔离 sizing 维度）
for ln in (918, 729):
    set_line(ln,
      '    // 钉住 20% 上限（默认 0.95 的舱位配额较大，钉 20% 让两笔小额持仓互不干扰）',
      'Task 65')

# L822：T17 尾注释
set_line(822,
  '    // 两仓均为权益 20%（cap=20% 低于舱位线 95%÷2=47.5%，上限原样生效）',
  '95%')

# T17b 块 826-860 → 用户复盘场景回归（边界：862 行 = test('T18 ）
assert_contains(826, "test('T17b")
assert_contains(826, 'Task 65')
assert lines[859].strip() == '});', repr(lines[859])
assert_contains(862, "test('T18")
T17B = '''  test('T17b Task 67 舱位划分回归（用户复盘场景）：marginRatio=0.95 默认 + 两舱——首仓不再吃满 95%，两仓各 ≈47.5%', async () => {
    await trendTradeRepo.seedConfig({
      name: TREND_TRADE.ACCOUNT_NAME,
      mode: 'RUNNING',
      initialCapital: 100,
      marginRatio: 0.95,
      leverage: 20,
      maxPositions: 2,
      slippageBps: 2,
      peakEquity: 0,
    });
    const engine = new FakePaperEngine();
    engine.marks.set('BTCUSDT', 100);
    engine.marks.set('ETHUSDT', 50);
    const signals: UnifiedTrendSignal[] = [
      sig({ symbol: 'BTCUSDT', phase: 'CONFIRMED_UP', cycleId: 'BTCUSDT:L:803' }),
      sig({ symbol: 'ETHUSDT', phase: 'CONFIRMED_UP', cycleId: 'ETHUSDT:L:804' }),
    ];
    const trader = makeTrader(signals, engine);
    await trader.ensureStarted();
    await openViaPending(signals, trader, 0); // BTC 首仓：min(95%, 95%÷2)=47.5% → margin 47.50
    signals[1] = nextBar(signals[1]!);
    await trader.tick(); // ETH 第 2 仓：同为 47.5% 配额（权益扣一笔手续费后重算）
    const rows = await openPositions();
    expect(rows.length).toBe(2);
    const floor2 = (v: number) => Math.floor((v + 1e-9) * 100) / 100;
    const m1 = floor2(100 * 0.475); // 47.50（Task 65 动态版首仓会吃满 95%；Task 67 按两舱划分各 47.5%）
    const m2 = floor2((100 - m1 * 20 * TAKER_FEE) * 0.475); // ≈47.41
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.get('BTCUSDT')!.margin).toBeCloseTo(m1, 2);
    expect(bySymbol.get('ETHUSDT')!.margin).toBeCloseTo(m2, 2);
    // 关键断言（Task 67）：首仓不再吃满 95%——选两舱则各按 95%/2 划分，先开仓不挤占后舱
    expect(m1).toBeCloseTo(47.5, 2);
    expect(m1).toBeLessThan(48);
    // 两仓开满后总保证金 ≈ 权益 95%（满舱预算 MARGIN_SLOT_HEADROOM 兑现，留 5% 手续费/浮亏缓冲）
    expect(m1 + m2).toBeGreaterThan(94);
    expect(m1 + m2).toBeLessThan(95);
  });'''
lines[825:860] = T17B.split('\n')

# L729 已在上面处理；L651 已由先前 Edit 落盘，跳过

# L369：已由先前 Edit 落盘，跳过

# L356：已由先前 Edit 落盘，跳过

# L4：已由先前 Edit 落盘，跳过

P.write_text('\n'.join(lines), encoding='utf-8')
print('OK: all test edits applied')
