#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Task 75：反向跟随（镜像执行）接口——对所有算法生效
#
# 设计（用户口径：模型开多→我们开空；模型硬止损→我们止盈；模型止盈→我们止损）：
# - infra 布尔参数 reverseMode（控制台新分组「执行模式（基础设施）」，DB 列持久化、热生效、
#   恢复默认回关）——天然适应全部算法（现状与未来）：策略无关、执行层实现。
# - 唯一咽喉点 executeOpen（信号路径/待入场转换/事件路径/直开路径全走它）：
#   仅翻转 engine.open 的执行侧（execSide），meta.side 保持模型侧——
#   evaluateExit 显式接收 meta.side（auto-trader.ts:769）、REVERSE_CONFIRMED 判断用 meta.side
#   （:788）、再入场/轮次/假突破反手等策略内部状态全部按模型语义运转，模型世界零扰动。
#   平仓按 positionId 执行、时机跟随模型 → 模型止损=我们止盈、模型止盈=我们止损，盈亏镜像。
# - 强平按真实仓位由 paper 引擎如实模拟（镜像世界的真实风险）；权益/未实现盈亏用真实
#   持仓 side 计算（:1376），不受影响。
# - 决策审计：openDetail 记录 reverseMode/modelSide/execSide 快照 + logDecision 反向执行行。

import sys

fails = []

def rep(text, old, new, cnt, tag):
    n = text.count(old)
    if n != cnt:
        fails.append(f'[{tag}] 期望 {cnt} 处，实际 {n} 处：{old[:80]!r}')
        return text
    return text.replace(old, new)

def load(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()

def save(p, t):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(t)

# ============ 1. console-params.ts：参数定义 + 校验 + 合并 ============
P = '/home/z/my-project/src/lib/market/trend-trade/console-params.ts'
c = load(P)

c = rep(c, """    effect: '调大 → 单仓更大（舱位配额内生效）；舱位配额本身由「持仓数量」决定（1 舱 95%、2 舱各 47.5%、3 舱各 31.7%…）；调小 → 在舱位配额内进一步压低单仓',
  },
];""",
"""    effect: '调大 → 单仓更大（舱位配额内生效）；舱位配额本身由「持仓数量」决定（1 舱 95%、2 舱各 47.5%、3 舱各 31.7%…）；调小 → 在舱位配额内进一步压低单仓',
  },
  // ===== I · 执行模式（基础设施；Task 75 反向跟随） =====
  {
    key: 'reverseMode', scope: 'infra', group: '执行模式（基础设施）',
    label: '反向跟随（镜像执行）', type: 'boolean', default: false,
    desc: '开启后对全部算法（含将来新增算法）生效：策略每次开仓方向取反执行——模型开多→实际开空、模型开空→实际开多；保证金/杠杆/轮次/审计与正常模式完全一致。平仓时机仍跟随模型：模型硬止损=我们止盈离场、模型止盈/趋势结束/反向确认=我们止损离场，盈亏与模型互为镜像。强平仍按真实仓位由模拟引擎如实执行。',
    effect: '开 = 与全部模型对着做（验证模型反向价值/镜像视角）；关 = 正常跟随（默认）',
  },
];""", 1, 'PARAM_DEFS追加reverseMode')

c = rep(c, "  infra: { waitBarConfirm?: number | null; cooldownMs?: number | null; marginRatio?: number | null },",
          "  infra: { waitBarConfirm?: number | null; cooldownMs?: number | null; marginRatio?: number | null; reverseMode?: number | null },",
          1, 'effectiveRuntimeParams签名')

c = rep(c, """      } else if (d.key === 'marginRatio') {
        if (infra.marginRatio != null) value = infra.marginRatio;
      }""",
"""      } else if (d.key === 'marginRatio') {
        if (infra.marginRatio != null) value = infra.marginRatio;
      } else if (d.key === 'reverseMode') {
        value = infra.reverseMode != null ? infra.reverseMode !== 0 : false;
      }""", 1, 'effectiveRuntimeParams分支')

c = rep(c, """): { strategyParams: Record<string, unknown>; waitBarConfirm?: number; cooldownMs?: number; marginRatio?: number } {
  const out: { strategyParams: Record<string, unknown>; waitBarConfirm?: number; cooldownMs?: number; marginRatio?: number } = {""",
"""): { strategyParams: Record<string, unknown>; waitBarConfirm?: number; cooldownMs?: number; marginRatio?: number; reverseMode?: number } {
  const out: { strategyParams: Record<string, unknown>; waitBarConfirm?: number; cooldownMs?: number; marginRatio?: number; reverseMode?: number } = {""",
1, 'lenient类型')

c = rep(c, """      if (def.scope === 'strategy' && def.strategyId === strategyId) (out.strategyParams as Record<string, boolean>)[key] = value;
      else if (key === 'waitBarConfirm') out.waitBarConfirm = value ? 1 : 0;
    }
  }
  return out;
}""",
"""      if (def.scope === 'strategy' && def.strategyId === strategyId) (out.strategyParams as Record<string, boolean>)[key] = value;
      else if (key === 'waitBarConfirm') out.waitBarConfirm = value ? 1 : 0;
      else if (key === 'reverseMode') out.reverseMode = value ? 1 : 0;
    }
  }
  return out;
}""", 1, 'lenient布尔分支')

c = rep(c, """  cooldownMs?: number;
  /** 每仓保证金比例（Task 58；TrendAutoConfig.marginRatio 列，NOT NULL DEFAULT 0.2） */
  marginRatio?: number;
}""",
"""  cooldownMs?: number;
  /** 每仓保证金比例（Task 58；TrendAutoConfig.marginRatio 列，NOT NULL DEFAULT 0.2） */
  marginRatio?: number;
  /** Task 75：反向跟随开关（1 = 开仓方向取反执行；0 = 正常跟随默认） */
  reverseMode?: number;
}""", 1, 'strict类型')

c = rep(c, """      if (def.scope === 'strategy') (out.strategyParams as Record<string, boolean>)[key] = value;
      else if (key === 'waitBarConfirm') out.waitBarConfirm = value ? 1 : 0;
    }
  }
  return out;
}""",
"""      if (def.scope === 'strategy') (out.strategyParams as Record<string, boolean>)[key] = value;
      else if (key === 'waitBarConfirm') out.waitBarConfirm = value ? 1 : 0;
      else if (key === 'reverseMode') out.reverseMode = value ? 1 : 0;
    }
  }
  return out;
}""", 1, 'strict布尔分支')

save(P, c)

# ============ 2. repo.ts：ConfigRow 类型 + 补列 + 读写 ============
P = '/home/z/my-project/src/lib/market/trend-trade/repo.ts'
c = load(P)

c = rep(c, """  /** Task 57-c：同币种平仓后冷却 ms（NULL = 用 TREND_TRADE.COOLDOWN_MS 默认） */
  cooldownMs?: number | null;
}""",
"""  /** Task 57-c：同币种平仓后冷却 ms（NULL = 用 TREND_TRADE.COOLDOWN_MS 默认） */
  cooldownMs?: number | null;
  /** Task 75：反向跟随开关（1 = 全算法开仓方向取反执行；0 = 正常跟随默认） */
  reverseMode?: number;
}""", 1, 'ConfigRow类型')

c = rep(c, """  if (!cfgCols.some((c) => c.name === 'cooldownMs')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendAutoConfig ADD COLUMN cooldownMs INTEGER`);
  }""",
"""  if (!cfgCols.some((c) => c.name === 'cooldownMs')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendAutoConfig ADD COLUMN cooldownMs INTEGER`);
  }
  // Task 75：反向跟随开关（幂等补列）
  if (!cfgCols.some((c) => c.name === 'reverseMode')) {
    await client.$executeRawUnsafe(`ALTER TABLE TrendAutoConfig ADD COLUMN reverseMode INTEGER DEFAULT 0`);
  }""", 1, 'ensureSchema补列')

c = rep(c, """                strategyParamsJson, waitBarConfirm, cooldownMs
         FROM TrendAutoConfig WHERE name = ?`,""",
"""                strategyParamsJson, waitBarConfirm, cooldownMs, reverseMode
         FROM TrendAutoConfig WHERE name = ?`,""", 1, 'loadConfig SELECT')

c = rep(c, """            waitBarConfirm: r.waitBarConfirm == null ? 1 : Number(r.waitBarConfirm),
            cooldownMs: numOrNull(r.cooldownMs),""",
"""            waitBarConfirm: r.waitBarConfirm == null ? 1 : Number(r.waitBarConfirm),
            cooldownMs: numOrNull(r.cooldownMs),
            reverseMode: r.reverseMode == null ? 0 : Number(r.reverseMode),""", 1, 'loadConfig映射')

c = rep(c, """      patch: { strategyParamsJson?: string | null; waitBarConfirm?: number; cooldownMs?: number | null; marginRatio?: number },""",
"""      patch: { strategyParamsJson?: string | null; waitBarConfirm?: number; cooldownMs?: number | null; marginRatio?: number; reverseMode?: number },""",
1, 'updateRuntimeParams类型')

c = rep(c, """      if (patch.marginRatio !== undefined) {
        sets.push('marginRatio = ?');
        args.push(patch.marginRatio);
      }""",
"""      if (patch.marginRatio !== undefined) {
        sets.push('marginRatio = ?');
        args.push(patch.marginRatio);
      }
      if (patch.reverseMode !== undefined) {
        sets.push('reverseMode = ?');
        args.push(patch.reverseMode);
      }""", 1, 'updateRuntimeParams写入')

save(P, c)

# ============ 3. auto-trader.ts：热参数 + executeOpen 翻转 + 审计 ============
P = '/home/z/my-project/src/lib/market/trend-trade/auto-trader.ts'
c = load(P)

c = rep(c, """  async setRuntimeParams(patch: {
    strategyParams?: Record<string, unknown>;
    waitBarConfirm?: number;
    cooldownMs?: number;
    marginRatio?: number;
  }): Promise<void> {""",
"""  async setRuntimeParams(patch: {
    strategyParams?: Record<string, unknown>;
    waitBarConfirm?: number;
    cooldownMs?: number;
    marginRatio?: number;
    reverseMode?: number;
  }): Promise<void> {""", 1, 'setRuntimeParams签名')

c = rep(c, """    const dbPatch: {
      strategyParamsJson?: string | null;
      waitBarConfirm?: number;
      cooldownMs?: number | null;
      marginRatio?: number;
    } = {};""",
"""    const dbPatch: {
      strategyParamsJson?: string | null;
      waitBarConfirm?: number;
      cooldownMs?: number | null;
      marginRatio?: number;
      reverseMode?: number;
    } = {};""", 1, 'setRuntimeParams dbPatch类型')

c = rep(c, """    if (patch.marginRatio !== undefined) dbPatch.marginRatio = patch.marginRatio;""",
"""    if (patch.marginRatio !== undefined) dbPatch.marginRatio = patch.marginRatio;
    if (patch.reverseMode !== undefined) dbPatch.reverseMode = patch.reverseMode;""", 1, 'dbPatch接线')

c = rep(c, """    // marginRatio 为基础设施列：每 tick 重读 cfg，下一 tick 生效（无需重装配）
    if (patch.marginRatio !== undefined) {
      logDecision(`参数控制台：每仓保证金比例已更新为 ${patch.marginRatio}（下一 tick 生效；实际比例 = min(设定值, 95%÷配置舱位数)）`);
    }
  }""",
"""    // marginRatio 为基础设施列：每 tick 重读 cfg，下一 tick 生效（无需重装配）
    if (patch.marginRatio !== undefined) {
      logDecision(`参数控制台：每仓保证金比例已更新为 ${patch.marginRatio}（下一 tick 生效；实际比例 = min(设定值, 95%÷配置舱位数)）`);
    }
    // Task 75：反向跟随为基础设施列，每 tick 重读 cfg，下一 tick 生效
    if (patch.reverseMode !== undefined) {
      logDecision(
        `参数控制台：反向跟随已${patch.reverseMode === 1 ? '开启（全部算法开仓方向取反执行；平仓仍跟随模型：模型止损=我们止盈、模型止盈=我们止损）' : '关闭（恢复正常跟随）'}（下一 tick 生效）`,
      );
    }
  }""", 1, 'reverseMode日志')

c = rep(c, """    await this.repo.updateRuntimeParams(name, {
      strategyParamsJson: JSON.stringify(map),
      waitBarConfirm: 1,
      cooldownMs: null,
      marginRatio: TREND_TRADE.MARGIN_RATIO, // 列 NOT NULL，回默认值而非 null
    });""",
"""    await this.repo.updateRuntimeParams(name, {
      strategyParamsJson: JSON.stringify(map),
      waitBarConfirm: 1,
      cooldownMs: null,
      marginRatio: TREND_TRADE.MARGIN_RATIO, // 列 NOT NULL，回默认值而非 null
      reverseMode: 0, // Task 75：反向跟随回关（正常跟随为默认）
    });""", 1, 'resetRuntimeParams回关')

c = rep(c, """    try {
      const pos = await this.engine.open({
        symbol: signal.symbol,
        side,
        leverage: cfg.leverage,
        margin: targetMargin,
      });""",
"""    try {
      // Task 75 反向跟随（infra reverseMode，控制台可调、全算法生效）：仅翻转真实执行方向，
      // 模型决策世界不变——meta.side 保持模型侧（evaluateExit/REVERSE_CONFIRMED/再入场/轮次
      // 等策略逻辑全部按模型语义运转），真实持仓为 execSide；平仓按 positionId 执行、时机跟随
      // 模型 → 模型硬止损=我们止盈离场、模型止盈/趋势结束=我们止损离场，盈亏互为镜像；
      // 强平按真实仓位由 paper 引擎如实模拟（权益/未实现盈亏本就按真实持仓 side 计算）。
      const reverse = (cfg.reverseMode ?? 0) === 1;
      const execSide: 'LONG' | 'SHORT' = reverse ? (side === 'LONG' ? 'SHORT' : 'LONG') : side;
      if (reverse) {
        logDecision(
          `反向跟随执行 模型${side === 'LONG' ? '开多' : '开空'} → 实际${execSide === 'LONG' ? '开多' : '开空'} ` +
          `symbol=${signal.symbol} rKey=${rKey} margin=${targetMargin}`,
        );
      }
      const pos = await this.engine.open({
        symbol: signal.symbol,
        side: execSide,
        leverage: cfg.leverage,
        margin: targetMargin,
      });""", 1, 'executeOpen翻转')

c = rep(c, """      detail: JSON.stringify(this.openDetail(signal, targetMargin, cfg, verdict.modeTag, riskMultiplier)),""",
"""      detail: JSON.stringify(this.openDetail(signal, targetMargin, cfg, verdict.modeTag, riskMultiplier, side)),""",
1, 'openDetail调用带side')

c = rep(c, """  private openDetail(signal: UnifiedTrendSignal, margin: number, cfg: TrendAutoConfigRow, modeTag: string, riskMultiplier = 1) {""",
"""  private openDetail(signal: UnifiedTrendSignal, margin: number, cfg: TrendAutoConfigRow, modeTag: string, riskMultiplier = 1, side: 'LONG' | 'SHORT' = 'LONG') {""",
1, 'openDetail签名')

c = rep(c, """      efficiencyRatio: signal.features.efficiencyRatio,
      htfAgree: signal.htfAgree,
    };
  }""",
"""      efficiencyRatio: signal.features.efficiencyRatio,
      htfAgree: signal.htfAgree,
      // Task 75：反向跟随快照（开启时记录模型侧与实际执行侧；平仓仍跟随模型）
      ...((cfg.reverseMode ?? 0) === 1
        ? { reverseMode: true, modelSide: side, execSide: side === 'LONG' ? 'SHORT' : 'LONG' }
        : { reverseMode: false }),
    };
  }""", 1, 'openDetail快照')

save(P, c)

# ============ 4. control 路由：透传 reverseMode ============
P = '/home/z/my-project/src/app/api/trend-trading/control/route.ts'
c = load(P)
c = rep(c, """        await engine.autoTrader.setRuntimeParams({
          strategyParams: sanitized.strategyParams as Record<string, unknown>,
          waitBarConfirm: sanitized.waitBarConfirm,
          cooldownMs: sanitized.cooldownMs,
          marginRatio: sanitized.marginRatio,
        });""",
"""        await engine.autoTrader.setRuntimeParams({
          strategyParams: sanitized.strategyParams as Record<string, unknown>,
          waitBarConfirm: sanitized.waitBarConfirm,
          cooldownMs: sanitized.cooldownMs,
          marginRatio: sanitized.marginRatio,
          reverseMode: sanitized.reverseMode,
        });""", 1, 'control透传')
save(P, c)

# ============ 5. overview 路由：合并 reverseMode 生效值 ============
P = '/home/z/my-project/src/app/api/trend-trading/route.ts'
c = load(P)
c = rep(c, """    const consoleParams = effectiveRuntimeParams(strategyIdNow, strategyOverrides, {
      waitBarConfirm: cfg?.waitBarConfirm ?? null,
      cooldownMs: cfg?.cooldownMs ?? null,
      marginRatio: cfg?.marginRatio ?? null,
    });""",
"""    const consoleParams = effectiveRuntimeParams(strategyIdNow, strategyOverrides, {
      waitBarConfirm: cfg?.waitBarConfirm ?? null,
      cooldownMs: cfg?.cooldownMs ?? null,
      marginRatio: cfg?.marginRatio ?? null,
      reverseMode: cfg?.reverseMode ?? null,
    });""", 1, 'overview合并')
save(P, c)

# ============ 6. engine.ts：单例 v24 → v25 ============
P = '/home/z/my-project/src/lib/market/enhanced/engine.ts'
c = load(P)
c = rep(c, "  __binanceRadarEnhanced_v24?: EnhancedEngine; // v24（Task 73 续）：同步采集器 v6 重建\n};",
          "  __binanceRadarEnhanced_v24?: EnhancedEngine; // v24（Task 73 续）：同步采集器 v6 重建\n  __binanceRadarEnhanced_v25?: EnhancedEngine; // v25（Task 75）：反向跟随（executeOpen 执行侧翻转）\n};", 1, 'v25类型声明')
c = rep(c, "    __binanceRadarEnhanced_v24?: EnhancedEngine;\n  },\n): EnhancedEngine | undefined {",
          "    __binanceRadarEnhanced_v24?: EnhancedEngine;\n    __binanceRadarEnhanced_v25?: EnhancedEngine;\n  },\n): EnhancedEngine | undefined {", 1, 'v25 pickLegacy参数')
c = rep(c, "    g.__binanceRadarEnhanced_v24 ??\n    g.__binanceRadarEnhanced_v23 ??",
          "    g.__binanceRadarEnhanced_v25 ??\n    g.__binanceRadarEnhanced_v24 ??\n    g.__binanceRadarEnhanced_v23 ??", 1, 'v25链头')
c = rep(c, "  const existing = g.__binanceRadarEnhanced_v24;", "  const existing = g.__binanceRadarEnhanced_v25;", 1, 'v25 get-existing')
c = rep(c, "  g.__binanceRadarEnhanced_v24 = fresh;", "  g.__binanceRadarEnhanced_v25 = fresh;", 2, 'v25赋值×2')
c = rep(c, "  const old = g.__binanceRadarEnhanced_v24 ?? pickLegacyEngine(g);", "  const old = g.__binanceRadarEnhanced_v25 ?? pickLegacyEngine(g);", 1, 'v25 reset-old')
save(P, c)

# ============ 7. UI：头部反向跟随徽标 ============
P = '/home/z/my-project/src/components/trend-trade/trend-trade-view.tsx'
c = load(P)
c = rep(c, "  const isMajorP1 = strategyId === 'major-p1-breakout-v1';",
          """  const isMajorP1 = strategyId === 'major-p1-breakout-v1';
  // Task 75：反向跟随开关状态（overview params 的 infra 布尔参数）
  const reverseModeOn = (data?.config.params ?? []).some((p) => p.key === 'reverseMode' && p.value === true);""",
1, 'reverseModeOn变量')

c = rep(c, """        <ModeBadge mode={mode} />
        <span className="hidden text-[10px] text-muted-foreground sm:inline">{headerInfo}</span>""",
"""        <ModeBadge mode={mode} />
        {reverseModeOn && (
          <span
            className="rounded bg-down/15 px-2 py-0.5 text-[11px] font-bold text-down"
            title="反向跟随已开启：所有算法开仓方向取反执行（模型开多→实际开空、开空→实际开多），保证金/轮次/审计不变；平仓时机仍跟随模型——模型硬止损=我们止盈、模型止盈=我们止损（盈亏互为镜像）。可在参数控制台关闭。"
          >
            反向跟随
          </span>
        )}
        <span className="hidden text-[10px] text-muted-foreground sm:inline">{headerInfo}</span>""",
1, '头部徽标')
save(P, c)

if fails:
    print('FAIL:\n' + '\n'.join(fails))
    sys.exit(1)
print('OK 反向跟随 7 文件补丁全部命中')
