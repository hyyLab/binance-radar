// 诊断：确认信号 bar 的 score / ER / HTF 分布（ENTRY_MIN_SCORE=70 可行性核查）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  scanAnomalyCandidates,
  type TrendState,
  type WatchOhlcvSeries,
} from 'universal-trend-engine';
import { TREND_WATCH, trendEngineConfig } from '../../src/lib/market/trend-watch/config';

void TREND_WATCH;
const DATA_DIR = '/home/z/my-project/scripts/replay/data';
const trendCfg = trendEngineConfig();
const files = existsSync(DATA_DIR) ? (readdirSync(DATA_DIR) as string[]) : [];
const symbols = files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

interface Bar { t: number; o: number; h: number; l: number; c: number; qv: number }
const history = new Map<string, Bar[]>();
for (const s of symbols) history.set(s, JSON.parse(readFileSync(`${DATA_DIR}/${s}.json`, 'utf8')) as Bar[]);
const t0 = Math.min(...[...history.values()].map((b) => b[0]!.t));
const t1 = Math.max(...[...history.values()].map((b) => b[b.length - 1]!.t));

const INTERVAL_MS = 60_000;
const warmupBars = 480;
const startT = t0 + warmupBars * INTERVAL_MS;
const uteStates = new Map<string, TrendState>();

const scores: number[] = [];
const ers: number[] = [];
// 同时统计「确认相位首根 bar」（新周期第一根）——与开仓时机对齐的口径
let confirmedFirstBar = 0;

for (let T = startT; T <= t1; T += INTERVAL_MS) {
  for (const symbol of symbols) {
    const bars = history.get(symbol)!;
    let lo = 0, hi = bars.length - 1, idx = -1;
    const target = T - INTERVAL_MS;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.t === target) { idx = mid; break; }
      if (bars[mid]!.t < target) lo = mid + 1; else hi = mid - 1;
    }
    if (idx < 0) continue;
    const win = bars.slice(Math.max(0, idx - warmupBars + 1), idx + 1);
    const series: WatchOhlcvSeries = {
      symbol, barMs: win.map((b) => b.t), opens: win.map((b) => b.o),
      highs: win.map((b) => b.h), lows: win.map((b) => b.l),
      closes: win.map((b) => b.c), vols: win.map((b) => b.qv),
    };
    const res = scanAnomalyCandidates([{ series, anomalyFlag: false }], uteStates, T, trendCfg, INTERVAL_MS);
    for (const [k, v] of res.states) uteStates.set(k, v);
    const sig = res.signals.find((s) => s.symbol === symbol)!;
    if (sig.phase === 'confirmed' && sig.assessment.features) {
      scores.push(sig.lastScore);
      ers.push(sig.assessment.features.efficiencyRatio);
    }
  }
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
}
console.log(`确认 bar 总数: ${scores.length}`);
console.log(`score: max=${Math.max(...scores)} p99=${pct(scores, 0.99)} p95=${pct(scores, 0.95)} p90=${pct(scores, 0.9)} p50=${pct(scores, 0.5)}`);
console.log(`score>=70 的 bar: ${scores.filter((s) => s >= 70).length} (${((scores.filter((s) => s >= 70).length / scores.length) * 100).toFixed(2)}%)`);
console.log(`score>=65 的 bar: ${scores.filter((s) => s >= 65).length} (${((scores.filter((s) => s >= 65).length / scores.length) * 100).toFixed(2)}%)`);
console.log(`score>=60 的 bar: ${scores.filter((s) => s >= 60).length} (${((scores.filter((s) => s >= 60).length / scores.length) * 100).toFixed(2)}%)`);
console.log(`ER: max=${Math.max(...ers).toFixed(3)} p90=${pct(ers, 0.9).toFixed(3)} p50=${pct(ers, 0.5).toFixed(3)}`);
console.log(`ER>=0.4 的 bar: ${ers.filter((e) => e >= 0.4).length} (${((ers.filter((e) => e >= 0.4).length / ers.length) * 100).toFixed(2)}%)`);
const both = scores.filter((s, i) => s >= 70 && ers[i]! >= 0.4).length;
const both60 = scores.filter((s, i) => s >= 60 && ers[i]! >= 0.4).length;
const both55 = scores.filter((s, i) => s >= 55 && ers[i]! >= 0.4).length;
console.log(`score>=70 且 ER>=0.4: ${both} bar`);
console.log(`score>=60 且 ER>=0.4: ${both60} bar`);
console.log(`score>=55 且 ER>=0.4: ${both55} bar`);
