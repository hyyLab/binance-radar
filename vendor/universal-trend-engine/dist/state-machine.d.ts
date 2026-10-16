import type { TrendAssessment, TrendSignal, TrendState } from "./types.js";
export declare function createTrendState(symbol: string): TrendState;
export declare function updateTrendState(previous: TrendState, assessment: TrendAssessment, now?: number, confirmObservations?: number): TrendSignal;
//# sourceMappingURL=state-machine.d.ts.map