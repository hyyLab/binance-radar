export function createTrendState(symbol) {
    return {
        symbol,
        phase: "idle",
        direction: "flat",
        candidateDirection: "flat",
        consecutiveObservations: 0,
        changedAt: null,
        lastUpdatedAt: null,
        lastObservationKey: null,
        lastScore: 0
    };
}
export function updateTrendState(previous, assessment, now = Date.now(), confirmObservations = 3) {
    if (!Number.isInteger(confirmObservations) || confirmObservations < 1) {
        throw new Error("confirmObservations must be a positive integer");
    }
    let next = { ...previous, lastUpdatedAt: now, lastScore: assessment.score };
    if (!assessment.eligible || assessment.direction === "flat") {
        next = {
            ...next,
            phase: "idle",
            direction: "flat",
            candidateDirection: "flat",
            consecutiveObservations: 0,
            changedAt: previous.phase === "idle" ? previous.changedAt : now
        };
        return { ...next, assessment };
    }
    const observationKey = assessment.features?.latestBarTime;
    if (observationKey !== undefined && observationKey === previous.lastObservationKey) {
        // Polling the same closed bar must not count as another confirmation.
        return { ...next, assessment };
    }
    if (observationKey !== undefined)
        next.lastObservationKey = observationKey;
    const direction = assessment.direction;
    const sameCandidate = previous.phase === "candidate" && previous.candidateDirection === direction;
    const alreadyConfirmed = previous.phase === "confirmed" && previous.direction === direction;
    if (alreadyConfirmed) {
        next = { ...next, direction, candidateDirection: direction, consecutiveObservations: confirmObservations };
    }
    else {
        const count = sameCandidate ? previous.consecutiveObservations + 1 : 1;
        if (count >= confirmObservations) {
            next = {
                ...next,
                phase: "confirmed",
                direction,
                candidateDirection: direction,
                consecutiveObservations: count,
                changedAt: previous.direction === direction && previous.phase === "confirmed" ? previous.changedAt : now
            };
        }
        else {
            next = {
                ...next,
                phase: "candidate",
                direction: "flat",
                candidateDirection: direction,
                consecutiveObservations: count,
                changedAt: previous.phase === "candidate" && previous.candidateDirection === direction ? previous.changedAt : now
            };
        }
    }
    return { ...next, assessment };
}
//# sourceMappingURL=state-machine.js.map