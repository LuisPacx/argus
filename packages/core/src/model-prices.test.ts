import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_PRICES } from "./api-brain.ts";
import { MODEL_PRICES, priceOfModel, tokenCostUsd, UnknownModelPriceError } from "./model-prices.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("model prices", () => {
  it("covers every model argus routes to (haiku, sonnet) and the advisor model, each with cache-read and cache-write rates", () => {
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
      const p = priceOfModel(model);
      expect(p.inputPerMTok).toBeGreaterThan(0);
      expect(p.outputPerMTok).toBeGreaterThan(p.inputPerMTok);
      expect(p.cacheReadPerMTok).toBeGreaterThan(0);
      expect(p.cacheReadPerMTok).toBeLessThan(p.inputPerMTok);
      expect(p.cacheWrite5mPerMTok).toBeGreaterThan(p.inputPerMTok);
      expect(p.cacheWrite1hPerMTok).toBeGreaterThan(p.cacheWrite5mPerMTok);
    }
  });

  it("refuses an unknown model loudly instead of pricing it at 0", () => {
    expect(() => priceOfModel("claude-mystery-9")).toThrow(UnknownModelPriceError);
    expect(() => tokenCostUsd("claude-mystery-9", { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toThrow(/claude-mystery-9/);
  });

  it("the API backend's haiku price is the same one", () => {
    expect(API_PRICES["claude-haiku-5-5"]).toMatchObject({ inputPerMTok: MODEL_PRICES["claude-haiku-5-5"]!.inputPerMTok, outputPerMTok: MODEL_PRICES["claude-haiku-5-5"]!.outputPerMTok });
  });

  it("a real finished run's usage (its result's modelUsage, from a captured claude -p run) reproduces its total_cost_usd", () => {
    const result = fixture("claude-stream-json-finished.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; total_cost_usd?: number; modelUsage?: Record<string, Record<string, number>> })
      .find((m) => m.type === "result")!;
    let usd = 0;
    for (const [model, u] of Object.entries(result.modelUsage!)) {
      usd += tokenCostUsd(model, {
        input: u.inputTokens!,
        output: u.outputTokens!,
        cacheRead: u.cacheReadInputTokens!,
        cacheWrite5m: u.cacheCreationEphemeral5mInputTokens!,
        cacheWrite1h: u.cacheCreationEphemeral1hInputTokens!,
      });
    }
    // Exact to the sub-cent digits claude prints (the tolerance is the rounding of its 7 decimals).
    expect(Math.abs(usd - result.total_cost_usd!)).toBeLessThan(1e-7);
  });

  it("reproduces a finished sonnet run too (the Spec session of a real transcript's cost-state line: 2 in, 2384 out, 649 cache read, 4700 one-hour cache write)", () => {
    const usd = tokenCostUsd("claude-sonnet-5-5", { input: 2, output: 2384, cacheRead: 649, cacheWrite5m: 0, cacheWrite1h: 4700 });
    expect(Math.abs(usd - 0.0427089)).toBeLessThan(1e-7);
  });
});
