export interface Bar {
    /** Unix milliseconds or another consistently increasing timestamp. */
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export type TrendDirection = "up" | "down" | "flat";
export type TrendPhase = "idle" | "candidate" | "confirmed";
export interface TrendConfig {
    /** Number of recent bars used to estimate the directional move. */
    lookbackBars: number;
    /** Minimum bars needed before an assessment is meaningful. */
    minBars: number;
    /** Minimum absolute close-to-close return (%) to assign a direction. */
    minMovePct: number;
    /** Recent volume window length. */
    recentVolumeBars: number;
    /** Baseline volume window length before the recent window. */
    baselineVolumeBars: number;
    /** Volume ratio at which volume evidence reaches full strength. */
    strongVolumeRatio: number;
    /** Number of consecutive observations required for confirmation. */
    confirmObservations: number;
    /** Maximum allowed age of the newest bar, in milliseconds. */
    maxBarAgeMs: number;
}
export interface AssessmentOptions {
    /** Whether an upstream anomaly monitor has flagged this symbol. */
    anomalyFlag?: boolean;
    /** Caller-supplied wall-clock time; useful for deterministic replay tests. */
    now?: number;
}
export interface TrendFeatures {
    returnPct: number;
    directionalConsistency: number;
    volumeRatio: number;
    breakout: "up" | "down" | "none";
    rangeExpansion: number;
    anomalyFlag: boolean;
    barsUsed: number;
    latestBarTime: number;
}
export interface TrendAssessment {
    direction: TrendDirection;
    score: number;
    eligible: boolean;
    reason: string;
    features?: TrendFeatures;
}
export interface TrendState {
    symbol: string;
    phase: TrendPhase;
    direction: TrendDirection;
    candidateDirection: TrendDirection;
    consecutiveObservations: number;
    changedAt: number | null;
    lastUpdatedAt: number | null;
    /** Timestamp of the last distinct bar counted toward confirmation. */
    lastObservationKey: number | null;
    lastScore: number;
}
export interface TrendSignal extends TrendState {
    assessment: TrendAssessment;
}
//# sourceMappingURL=types.d.ts.map