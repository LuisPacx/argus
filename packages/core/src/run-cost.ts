import { tokenCostUsd, type TokenUsage } from "./model-prices.ts";

/**
 * What stands behind a recorded cost (hardening ticket 10): `exact` is the `total_cost_usd` of the run's own result (or the API's
 * reported usage), `estimated` is a figure argus worked out (the priced usage of the stream a killed run left behind, or an elapsed-time
 * estimate, or a charge at the route's cap), and `unknown` is a run that ended without a result, whose cost nothing recovered.
 */
export type CostSource = "exact" | "estimated" | "unknown";

/**
 * Cost of a killed run from the `assistant` events of its `--output-format stream-json` output, which is on disk (the Build log) even
 * when the child is killed. Checked against a real capture (fixtures/claude-stream-json-*.jsonl):
 *
 * - one event per content block, so a message with several blocks repeats its `message.id`: usage is counted once per id, taking the
 *   largest value of each field, and the content of its lines is summed;
 * - the usage of an event is the message's at its START: input and cache counts are final, but `output_tokens` is a stub (16 and 1 for a
 *   run that printed 161). So output is the larger of the stub and the content's size at `BYTES_PER_OUTPUT_TOKEN`; the figure is an
 *   estimate, and is stored as one;
 * - `cache_creation` splits writes into five-minute and one-hour (priced differently); when the split is missing the whole
 *   `cache_creation_input_tokens` is priced at the dearer one-hour rate;
 * - sub-agent turns (`parent_tool_use_id` set) are real spend and are counted;
 * - a `<synthetic>` message (claude's own error text) has no tokens and is skipped.
 *
 * A model with no price throws `UnknownModelPriceError` (never priced at 0); the caller then falls back to the elapsed-time estimate.
 */
export const BYTES_PER_OUTPUT_TOKEN = 3;

interface Turn {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWriteTotal: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  split: boolean;
  contentBytes: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function blockBytes(block: unknown): number {
  if (typeof block !== "object" || block === null) return 0;
  const b = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown };
  if (typeof b.text === "string") return Buffer.byteLength(b.text);
  if (typeof b.thinking === "string") return Buffer.byteLength(b.thinking);
  if (b.type === "tool_use") return Buffer.byteLength(String(b.name ?? "")) + Buffer.byteLength(JSON.stringify(b.input ?? {}));
  return 0;
}

export interface StreamSpendTotal {
  usd: number;
  /** Distinct assistant messages that were priced. */
  turns: number;
}

/** Accumulates a stream-json stdout chunk by chunk (the Build's live log) and prices what it has seen so far. */
export class StreamSpend {
  private buffer = "";
  private readonly turns = new Map<string, Turn>();

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (!line.startsWith("{")) return;
    let ev: { type?: unknown; message?: { id?: unknown; model?: unknown; content?: unknown; usage?: Record<string, unknown> } };
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const m = ev.message;
    if (ev.type !== "assistant" || !m || typeof m.id !== "string" || typeof m.model !== "string" || !m.usage || typeof m.usage !== "object") return;
    const u = m.usage;
    const cc = (typeof u.cache_creation === "object" && u.cache_creation !== null ? u.cache_creation : undefined) as Record<string, unknown> | undefined;
    const t = this.turns.get(m.id) ?? { model: m.model, input: 0, output: 0, cacheRead: 0, cacheWriteTotal: 0, cacheWrite5m: 0, cacheWrite1h: 0, split: false, contentBytes: 0 };
    t.input = Math.max(t.input, num(u.input_tokens));
    t.output = Math.max(t.output, num(u.output_tokens));
    t.cacheRead = Math.max(t.cacheRead, num(u.cache_read_input_tokens));
    t.cacheWriteTotal = Math.max(t.cacheWriteTotal, num(u.cache_creation_input_tokens));
    if (cc) {
      t.split = true;
      t.cacheWrite5m = Math.max(t.cacheWrite5m, num(cc.ephemeral_5m_input_tokens));
      t.cacheWrite1h = Math.max(t.cacheWrite1h, num(cc.ephemeral_1h_input_tokens));
    }
    if (Array.isArray(m.content)) for (const b of m.content) t.contentBytes += blockBytes(b);
    this.turns.set(m.id, t);
  }

  /** The priced total of the complete lines seen so far, or undefined when no message with tokens was seen. Throws for an unpriced model. */
  total(): StreamSpendTotal | undefined {
    let usd = 0;
    let turns = 0;
    for (const t of this.turns.values()) {
      const output = Math.max(t.output, Math.ceil(t.contentBytes / BYTES_PER_OUTPUT_TOKEN));
      const writes = t.split ? { cacheWrite5m: t.cacheWrite5m, cacheWrite1h: t.cacheWrite1h + Math.max(0, t.cacheWriteTotal - t.cacheWrite5m - t.cacheWrite1h) } : { cacheWrite5m: 0, cacheWrite1h: t.cacheWriteTotal };
      const usage: TokenUsage = { input: t.input, output, cacheRead: t.cacheRead, ...writes };
      if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h === 0) continue;
      usd += tokenCostUsd(t.model, usage);
      turns++;
    }
    return turns === 0 ? undefined : { usd, turns };
  }
}

/** The priced total of a whole stream-json stdout (the trailing half line, if any, is ignored). */
export function streamSpendOf(stdout: string): StreamSpendTotal | undefined {
  const s = new StreamSpend();
  s.push(stdout.endsWith("\n") ? stdout : stdout + "\n");
  return s.total();
}

/**
 * What a Build run that left no usable usage is charged: its minutes (at least one) times a dollar rate per minute, capped at what the
 * route still allows. Never 0 for a positive cap. The rate is the average of recent Builds, or `DEFAULT_BUILD_USD_PER_MINUTE`.
 */
export function elapsedEstimateUsd(elapsedMs: number, usdPerMinute: number, capUsd: number): number {
  const minutes = Math.max(1, elapsedMs / 60_000);
  return Math.max(0, Math.min(capUsd, minutes * usdPerMinute));
}

/**
 * The $/minute used when there are no recent Builds to average: the Build route's whole cap spread over its whole wall-clock cap
 * ($25 over 240 minutes), the rate of a Build that uses everything it is allowed. Kept here, beside the estimate, and checked against
 * DEFAULT_ROUTING by a test, so a changed cap cannot leave it behind.
 */
export const DEFAULT_BUILD_USD_PER_MINUTE = 25 / 240;

/** How many of the most recent finished Builds the average rate is taken over. */
export const RECENT_BUILDS_FOR_RATE = 10;
