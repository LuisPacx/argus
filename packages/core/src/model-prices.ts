/**
 * The one price table for turning token counts into dollars (hardening ticket 10). `API_PRICES` in api-brain.ts (the pay-as-you-go
 * backend, which never uses caching) takes its haiku rates from here; everything that prices a subscription run's tokens (a killed
 * Build's streamed usage, run-cost.ts) uses `tokenCostUsd`.
 *
 * Rates are US dollars per million tokens, from the claude-api skill's model table (2026-11-03) for input and output, and from the
 * cache rules (a cache read is a fixed fraction of input, a five-minute write 1.25 x input, a one-hour write 2 x input). They were
 * checked against what Claude Code itself recorded: a least-squares fit of the `modelUsage.costUSD` of the `cost-state` lines of 1763
 * real session transcripts reproduces these rates for sonnet and opus to 1e-11, and haiku to the cent (haiku's web search, $0.01 a
 * request, is the only other charge in them, and no argus route that streams usage has a web tool).
 *
 * A model that is not listed is refused (`UnknownModelPriceError`), never priced at 0: a cost that cannot be priced is unknown, and the
 * caller falls back to an estimate that says so. Add a model here before routing anything to it.
 */
export interface TokenPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** A cache write with the default five-minute lifetime. */
  cacheWrite5mPerMTok: number;
  /** A cache write with the one-hour lifetime (what Claude Code asks for). */
  cacheWrite1hPerMTok: number;
}

export const MODEL_PRICES: Readonly<Record<string, TokenPrice>> = {
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWrite5mPerMTok: 0.125, cacheWrite1hPerMTok: 0.2 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4 },
  // Not routed to, but Claude Code can call it as the advisor of a session (the `advisorModel` of a transcript turn).
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWrite5mPerMTok: 5, cacheWrite1hPerMTok: 8 },
};

export interface TokenUsage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(`The model "${model}" has no known price; add it to MODEL_PRICES before using it`);
    this.name = "UnknownModelPriceError";
  }
}

export function priceOfModel(model: string): TokenPrice {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (!price) throw new UnknownModelPriceError(model);
  return price;
}

/** Dollars for `usage` on `model`. Throws `UnknownModelPriceError` for a model with no price. */
export function tokenCostUsd(model: string, usage: TokenUsage): number {
  const p = priceOfModel(model);
  return (usage.input * p.inputPerMTok + usage.output * p.outputPerMTok + usage.cacheRead * p.cacheReadPerMTok + usage.cacheWrite5m * p.cacheWrite5mPerMTok + usage.cacheWrite1h * p.cacheWrite1hPerMTok) / 1e6;
}
