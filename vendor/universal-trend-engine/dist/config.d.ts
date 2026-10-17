import type { TrendConfig } from "./types.js";
/**
 * Conservative generic defaults. Calibrate by market, bar interval, liquidity,
 * and replay results before using these values for live alerts.
 */
export declare const DEFAULT_TREND_CONFIG: Readonly<TrendConfig>;
export declare function resolveTrendConfig(overrides?: Partial<TrendConfig>): TrendConfig;
//# sourceMappingURL=config.d.ts.map