import type { AssessmentOptions, Bar, TrendConfig, TrendSignal, TrendState } from "./types.js";
export interface SymbolSnapshot {
    symbol: string;
    bars: Bar[];
    anomalyFlag?: boolean;
}
export interface ScanResult {
    signals: TrendSignal[];
    states: Map<string, TrendState>;
}
/**
 * Stateless scan helper for an upstream anomaly monitor.
 * Keep the returned states between scans to preserve confirmation history.
 */
export declare function scanCandidates(snapshots: SymbolSnapshot[], previousStates?: Map<string, TrendState>, options?: Omit<AssessmentOptions, "anomalyFlag">, config?: Partial<TrendConfig>): ScanResult;
//# sourceMappingURL=scanner.d.ts.map