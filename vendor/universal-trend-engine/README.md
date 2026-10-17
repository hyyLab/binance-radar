# Universal Trend Engine

A market-agnostic TypeScript engine for turning anomaly-monitoring candidates into explainable intraday trend signals.

## Why this exists

The anomaly monitor discovers symbols with unusual activity. This engine evaluates those symbols independently and ranks whether the activity is developing into a directional intraday trend. It is not tied to SOXL/KORU and does not fetch market data, send alerts, or place orders.

## MVP pipeline

1. Candidate intake — the caller supplies symbols flagged by an upstream anomaly monitor (for example, unusual volume or price movement).
2. Feature calculation — price return, directional consistency, range expansion, and volume ratio are calculated from OHLCV bars.
3. Trend assessment — each symbol receives a direction, score, evidence fields, and a preliminary state.
4. State confirmation — candidate signals must persist across configurable observations before becoming confirmed; reversals are handled explicitly.
5. Ranking — callers can sort candidate symbols by score and evidence.

## Design principles

- Market-data agnostic: adapters stay outside this package; feed it normalized bars.
- Single-symbol first: do not mix a symbol's own trend with pair-relative strength.
- Explainable: scores expose their component evidence instead of returning only a black-box label.
- Configurable, not one-size-fits-all: thresholds vary by asset class, bar interval, and liquidity. Defaults are starting points, not validated trading parameters.
- No execution: this package is analysis-only and does not provide trading or investment advice.

## Initial API

The public API is exported from src/index.ts. An adapter for your anomaly-monitor system should convert its bars into Bar objects and pass only symbols worth evaluating. The engine should not require every symbol to be a pair.

## Development

- Node.js 20+
- TypeScript
- Vitest

Run npm install, npm test, and npm run typecheck.

## Roadmap

- [x] Generic OHLCV input contract
- [x] Explainable single-symbol trend score
- [x] Per-symbol candidate/confirmed/reversal state
- [x] Multi-symbol ranking helper
- [ ] Replay tests against historical intraday bars
- [ ] Calibrate thresholds separately by market and timeframe
- [ ] Add a separate pair-relative-strength module only when needed
- [ ] Connect the engine to the anomaly monitor through an adapter

## Important limitation

The MVP is a clean foundation, not a claim of exact parity with the existing SOXL/KORU engine. Before replacing live signals, compare both systems on historical/replayed data and inspect false positives, missed trends, and confirmation delay.
