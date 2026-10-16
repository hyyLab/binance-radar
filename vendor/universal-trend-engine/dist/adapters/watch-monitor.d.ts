import type { ScanResult } from "../scanner.js";
import type { Bar, TrendConfig, TrendState } from "../types.js";
export interface WatchOhlcvSeries {
    symbol: string;
    /** K-line open timestamps in milliseconds, ascending. */
    barMs: number[];
    opens: number[];
    highs: number[];
    lows: number[];
    closes: number[];
    vols: number[];
}
export interface AnomalyCandidate {
    series: WatchOhlcvSeries;
    anomalyFlag?: boolean;
}
/**
 * Convert aligned watch-monitor arrays into closed OHLCV bars.
 *
 * The existing monitor's fetch layer currently retains close/volume/time only.
 * For breakout/range features to be trustworthy, the caller must also preserve
 * open/high/low from the original K-line response; do not synthesize them from
 * close prices. barMs is the candle open time, so Bar.time is set to its close
 * boundary and the still-forming candle is excluded.
 */
export declare function toClosedBars(series: WatchOhlcvSeries, intervalMs?: number, nowMs?: number): Bar[];
/** Adapter entry point: score only symbols already flagged by the anomaly monitor. */
export declare function scanAnomalyCandidates(candidates: AnomalyCandidate[], previousStates?: Map<string, TrendState>, nowMs?: number, config?: Partial<TrendConfig>, intervalMs?: number): ScanResult;
//# sourceMappingURL=watch-monitor.d.ts.map