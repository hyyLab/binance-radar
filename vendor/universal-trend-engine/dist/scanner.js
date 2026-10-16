import { assessTrend } from "./engine.js";
import { createTrendState, updateTrendState } from "./state-machine.js";
/**
 * Stateless scan helper for an upstream anomaly monitor.
 * Keep the returned states between scans to preserve confirmation history.
 */
export function scanCandidates(snapshots, previousStates = new Map(), options = {}, config = {}) {
    const states = new Map(previousStates);
    const signals = [];
    for (const snapshot of snapshots) {
        const assessment = assessTrend(snapshot.bars, { ...options, anomalyFlag: snapshot.anomalyFlag ?? false }, config);
        const previous = states.get(snapshot.symbol) ?? createTrendState(snapshot.symbol);
        const signal = updateTrendState(previous, assessment, options.now ?? Date.now(), config.confirmObservations ?? 3);
        states.set(snapshot.symbol, signal);
        signals.push(signal);
    }
    signals.sort((a, b) => {
        const phaseRank = (phase) => phase === "confirmed" ? 2 : phase === "candidate" ? 1 : 0;
        return phaseRank(b.phase) - phaseRank(a.phase) || b.lastScore - a.lastScore;
    });
    return { signals, states };
}
//# sourceMappingURL=scanner.js.map