import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UnknownModelPriceError } from "./model-prices.ts";
import { StreamSpend, streamSpendOf } from "./run-cost.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const turn = (id: string, usage: Record<string, unknown>, content: unknown[] = [{ type: "text", text: "x" }], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5-5", content, usage }, ...extra }) + "\n";

describe("streamed spend (stream-json assistant events)", () => {
  it("a real killed run (captured, SIGKILLed after its first turn) yields that turn's priced usage", () => {
    const s = streamSpendOf(fixture("claude-stream-json-killed.jsonl"))!;
    expect(s.turns).toBe(1);
    // 2 in, 3210 one-hour cache write, 1670 cache read, and at least the 16 output tokens the stream reported (haiku).
    expect(s.usd).toBeGreaterThan((2 * 0.1 + 3210 * 0.2 + 1670 * 0.01 + 16 * 0.5) / 1e6 - 1e-9);
    expect(s.usd).toBeLessThan(0.001);
  });

  it("a real finished run: the streamed figure is a lower-bound-ish estimate of total_cost_usd (the stream's output counts are start-of-message stubs)", () => {
    const text = fixture("claude-stream-json-finished.jsonl");
    const truth = JSON.parse(text.split("\n").filter(Boolean).at(-1)!).total_cost_usd as number;
    const s = streamSpendOf(text)!;
    expect(s.turns).toBe(2);
    // Input and cache tokens are exact in the stream; only output is under-reported, so it never overshoots and lands well inside 40% below.
    expect(s.usd).toBeLessThanOrEqual(truth * 1.02);
    expect(s.usd).toBeGreaterThanOrEqual(truth * 0.6);
  });

  it("counts a message once however many lines it was split over, taking the largest usage and summing its content blocks", () => {
    const usage = (out: number) => ({ input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    const once = streamSpendOf(turn("m1", usage(50)))!;
    const split = streamSpendOf(turn("m1", usage(5)) + turn("m1", usage(50)) + turn("m1", usage(50)))!;
    expect(split.turns).toBe(1);
    expect(split.usd).toBeCloseTo(once.usd, 10);
  });

  it("counts sub-agent turns (parent_tool_use_id set) too: they are real spend", () => {
    const u = { input_tokens: 1000, output_tokens: 0 };
    expect(streamSpendOf(turn("a", u) + turn("b", u, undefined, { parent_tool_use_id: "toolu_1" }))!.turns).toBe(2);
  });

  it("estimates output from the content when the stream's own count is a stub", () => {
    const big = "word ".repeat(3000); // 15000 bytes of text, about 5000 tokens at 3 bytes each
    const s = streamSpendOf(turn("m1", { input_tokens: 0, output_tokens: 1 }, [{ type: "text", text: big }]))!;
    expect(s.usd).toBeGreaterThan((5000 * 10) / 1e6 - 1e-9); // sonnet output $10/MTok
  });

  it("prices cache writes by their ttl and falls back to the dearer one-hour rate when the split is missing", () => {
    const split = streamSpendOf(turn("m", { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 } }, []))!;
    const total = streamSpendOf(turn("m", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, []))!;
    expect(split.usd).toBeCloseTo(2.5, 6);
    expect(total.usd).toBeCloseTo(4, 6);
  });

  it("is undefined when the stream has no usage at all (killed before the first turn, or not a stream)", () => {
    expect(streamSpendOf("")).toBeUndefined();
    expect(streamSpendOf('{"type":"system","subtype":"init","session_id":"x"}\n')).toBeUndefined();
    expect(streamSpendOf('{"type":"result","total_cost_usd":1}')).toBeUndefined();
  });

  it("ignores lines that are not JSON and a half line at the end", () => {
    const line = turn("m1", { input_tokens: 1000000, output_tokens: 0 }, []);
    expect(streamSpendOf("garbage\n" + line + line.slice(0, 40))!.usd).toBeCloseTo(2, 6);
  });

  it("refuses a model it has no price for, loudly", () => {
    const stray = JSON.stringify({ type: "assistant", message: { id: "m", model: "claude-mystery-9", content: [], usage: { input_tokens: 5, output_tokens: 5 } } }) + "\n";
    expect(() => streamSpendOf(stray)).toThrow(UnknownModelPriceError);
  });

  it("a synthetic message (claude's own error text, no tokens) is not priced", () => {
    const synthetic = JSON.stringify({ type: "assistant", message: { id: "m", model: "<synthetic>", content: [], usage: { input_tokens: 0, output_tokens: 0 } } }) + "\n";
    expect(streamSpendOf(synthetic)).toBeUndefined();
  });

  it("the incremental tracker gives the same total as the whole-stdout parse, whatever the chunk boundaries", () => {
    const text = fixture("claude-stream-json-finished.jsonl");
    const whole = streamSpendOf(text)!;
    const tracker = new StreamSpend();
    for (let i = 0; i < text.length; i += 37) tracker.push(text.slice(i, i + 37));
    expect(tracker.total()!.usd).toBeCloseTo(whole.usd, 12);
  });
});
