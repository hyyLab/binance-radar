#!/usr/bin/env bash
# 决定性校验：关键标识符 doc ↔ code 双向比对
set -u
DOC=/home/z/my-project/docs/strategy-interface.md
SRC=/home/z/my-project/src

TOKENS="TrendStrategy observe evaluateEntry evaluateExit nextRound onOpen onClose \
exportState importState bindPersistence STRATEGY_FACTORIES createStrategy listStrategies \
isKnownStrategy DEFAULT_STRATEGY_ID StrategyMarketCtx StrategyPositionCtx \
StrategyEntryVerdict StrategyExitVerdict StrategyDescriptor UnifiedTrendSignal TrendPhaseV2 \
TrendEndReason VolatilityFeatures HtfAssessment AnomalyContextDTO TrendAutoConfigRow \
TrendTradeMetaRow TrendPendingEntryRow TrendStrategyState TrendAutoDecision TrendWatchService \
AutoPaperTrader PaperEngine CONFIRMED_UP CONFIRMED_DOWN END_PENDING DATA_UNAVAILABLE OBSERVING \
CANDIDATE_UP CANDIDATE_DOWN ENDED TREND_ENDED REVERSE_CONFIRMED SPIKE_TAKE WEAKNESS_EARLY \
LIQUIDATED MANUAL TREND_TRADE SCAN_MS PENDING_EXPIRE_MS COOLDOWN_MS MARGIN_RATIO FEE_RATE \
SLIPPAGE_BPS MIN_MARGIN MAX_POSITIONS LEVERAGE SHORT_SWING ENTRY_MIN_SCORE ENTRY_MIN_ER \
NEUTRAL_MIN_SCORE NEUTRAL_MIN_ER MAX_ROUNDS_PER_CYCLE REENTRY_MIN_GAP_MS SPIKE_WINDOW_MS \
SPIKE_MOVE_PCT SPIKE_MIN_HOLD_MS WEAKNESS_EXIT_EARLY SAMPLE_TTL_MS ALLOW_HTF_OPPOSED \
manageEntries managePendings manageExits executeOpen closePosition closeAllManual \
setStrategyId applyStrategy setRuntimeParams resetRuntimeParams recentSkips markPrice \
PARAM_DEFS sanitizeRuntimeParams sanitizeRuntimeParamsLenient effectiveRuntimeParams DEF_BY_KEY \
short-swing-v1 waitBarConfirm cooldownMs marginRatio strategyId strategyParamsJson \
lastBarTime trendCycleId dataFresh endEvidenceBars endPendingSince firstEndSignAt \
mfe mae mfeAt mfeDrawdown entryBarTime entryRound dataUnavailableReason \
htf5m htf15m htfAgree efficiencyRatio atrPct realizedVolPct volPercentile volRegime \
breakout falseBreakout barsUsed __binanceRadarEnhanced_v15 pickLegacyEngine getEnhancedEngine \
liquidationCheck reconcile modeTag want reason strength confirmCount anomaly conflict \
changedAt trendStartedAt score equity balance marginUsed openCount openSymbols lastCloseAt \
entryPrice qty margin openedAt effectiveMarginRatio TrendExitReason HtfGateState \
PendingEntryStatus TrendAutoMode roundKey baseCycleOf pendingRoundOf liqPaperAccount"

printf '%-34s %6s %6s\n' TOKEN DOC CODE
fail=0
for t in $TOKENS; do
  d=$(rg -o -w -F "$t" "$DOC" 2>/dev/null | wc -l)
  c=$(rg -o -w -F "$t" "$SRC" 2>/dev/null | wc -l)
  flag=""
  if [ "$d" -gt 0 ] && [ "$c" -eq 0 ]; then flag="  <-- 文档有而代码无！"; fail=1; fi
  printf '%-34s %6s %6s%s\n' "$t" "$d" "$c" "$flag"
done
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: 全部关键标识符 doc↔code 一致"; else echo "RESULT: 存在不一致，需修复"; fi
