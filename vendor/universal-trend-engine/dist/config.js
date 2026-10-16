/**
 * Conservative generic defaults. Calibrate by market, bar interval, liquidity,
 * and replay results before using these values for live alerts.
 */
export const DEFAULT_TREND_CONFIG = Object.freeze({
    lookbackBars: 12,
    minBars: 16,
    minMovePct: 0.35,
    recentVolumeBars: 3,
    baselineVolumeBars: 10,
    strongVolumeRatio: 2,
    confirmObservations: 3,
    maxBarAgeMs: 5 * 60 * 1000
});
export function resolveTrendConfig(overrides = {}) {
    const config = { ...DEFAULT_TREND_CONFIG, ...overrides };
    for (const [key, value] of Object.entries(config)) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`Trend config ${key} must be a positive finite number`);
        }
    }
    if (config.minBars < config.lookbackBars + 1) {
        throw new Error("minBars must be at least lookbackBars + 1");
    }
    if (config.recentVolumeBars + config.baselineVolumeBars > config.minBars) {
        throw new Error("minBars must cover recent and baseline volume windows");
    }
    if (!Number.isInteger(config.confirmObservations)) {
        throw new Error("confirmObservations must be an integer");
    }
    return config;
}
//# sourceMappingURL=config.js.map