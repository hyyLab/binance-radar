import { DEFAULT_TREND_CONFIG, resolveTrendConfig } from "./config.js";
function average(values) {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
}
function validateBars(bars) {
    if (!Array.isArray(bars))
        return "bars must be an array";
    let previousTime = -Infinity;
    for (const bar of bars) {
        if (![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) {
            return "bar contains a non-finite value";
        }
        if (bar.close <= 0 || bar.open <= 0 || bar.low <= 0 || bar.high <= 0 || bar.volume < 0) {
            return "bar prices must be positive and volume cannot be negative";
        }
        if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close)) {
            return "bar OHLC values are inconsistent";
        }
        if (bar.time <= previousTime)
            return "bars must be ordered by strictly increasing time";
        previousTime = bar.time;
    }
    return null;
}
function buildFeatures(bars, anomalyFlag, config) {
    const last = bars[bars.length - 1];
    const start = bars[bars.length - 1 - config.lookbackBars];
    const returnPct = ((last.close / start.close) - 1) * 100;
    const recent = bars.slice(-config.recentVolumeBars);
    const baselineEnd = bars.length - config.recentVolumeBars;
    const baselineStart = baselineEnd - config.baselineVolumeBars;
    const baseline = bars.slice(baselineStart, baselineEnd);
    const baselineVolume = average(baseline.map((bar) => bar.volume));
    const recentVolume = average(recent.map((bar) => bar.volume));
    const volumeRatio = baselineVolume > 0 ? recentVolume / baselineVolume : 0;
    const moveSigns = bars.slice(-config.lookbackBars).map((bar, index, window) => {
        if (index === 0)
            return 0;
        const previous = window[index - 1];
        return Math.sign(bar.close - previous.close);
    }).filter((sign) => sign !== 0);
    const directionSign = Math.sign(returnPct);
    const directionalConsistency = moveSigns.length === 0 || directionSign === 0
        ? 0
        : moveSigns.filter((sign) => sign === directionSign).length / moveSigns.length;
    const priorBars = bars.slice(-(config.lookbackBars + 1), -1);
    const priorHigh = Math.max(...priorBars.map((bar) => bar.high));
    const priorLow = Math.min(...priorBars.map((bar) => bar.low));
    const breakout = last.close > priorHigh ? "up" : last.close < priorLow ? "down" : "none";
    const ranges = bars.slice(-config.lookbackBars).map((bar) => (bar.high - bar.low) / bar.close);
    const recentRange = average(ranges.slice(-Math.min(3, ranges.length)));
    const baselineRange = average(ranges.slice(0, Math.max(1, ranges.length - 3)));
    const rangeExpansion = baselineRange > 0 ? recentRange / baselineRange : 1;
    return {
        returnPct,
        directionalConsistency,
        volumeRatio,
        breakout,
        rangeExpansion,
        anomalyFlag,
        barsUsed: bars.length,
        latestBarTime: last.time
    };
}
export function assessTrend(bars, options = {}, overrides = {}) {
    const config = resolveTrendConfig({ ...DEFAULT_TREND_CONFIG, ...overrides });
    const invalid = validateBars(bars);
    if (invalid)
        return { direction: "flat", score: 0, eligible: false, reason: invalid };
    if (bars.length < config.minBars) {
        return { direction: "flat", score: 0, eligible: false, reason: `insufficient bars: need ${config.minBars}, got ${bars.length}` };
    }
    const now = options.now ?? Date.now();
    const latest = bars[bars.length - 1];
    if (now - latest.time > config.maxBarAgeMs) {
        return { direction: "flat", score: 0, eligible: false, reason: "latest bar is stale" };
    }
    const features = buildFeatures(bars, options.anomalyFlag ?? false, config);
    const direction = Math.abs(features.returnPct) < config.minMovePct
        ? "flat"
        : features.returnPct > 0 ? "up" : "down";
    if (direction === "flat") {
        return { direction, score: 0, eligible: true, reason: "move is below the configured directional threshold", features };
    }
    const returnStrength = clamp(Math.abs(features.returnPct) / (config.minMovePct * 3));
    const consistencyStrength = clamp((features.directionalConsistency - 0.4) / 0.6);
    const breakoutStrength = features.breakout === direction ? 1 : 0;
    const volumeStrength = clamp(features.volumeRatio / config.strongVolumeRatio);
    const rangeStrength = clamp((features.rangeExpansion - 0.8) / 1.2);
    // The anomaly flag is context, not proof of a trend; it contributes only a small score.
    const score = Math.round(100 * (0.35 * returnStrength +
        0.25 * consistencyStrength +
        0.20 * breakoutStrength +
        0.15 * volumeStrength +
        0.05 * rangeStrength) + (features.anomalyFlag ? 3 : 0));
    return {
        direction,
        score: Math.min(100, score),
        eligible: true,
        reason: features.breakout === direction
            ? "directional move with a same-direction range breakout"
            : "directional move detected; breakout confirmation is absent",
        features
    };
}
//# sourceMappingURL=engine.js.map