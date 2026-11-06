import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrainError, type Brain, type BrainBackend, type BrainInput, type BrainRun, type BrainRunOptions, type BrainTask } from "./brain.ts";

/**
 * ApiBrain: the pay-as-you-go backend behind the Brain interface (architecture section 5, ADR 0001). It runs `judge` and `propose`
 * only, never `spec` or `build`, as one Messages API request with the task's skill markdown as the system prompt. Unlike the
 * subscription, its runs cost real money, so every run is held to a daily cap in real dollars, in code:
 *
 * - the cap is checked BEFORE every call, against the dollars already spent plus the most this call can cost (its ceiling), and a call
 *   that might pass it is not made. A spend that cannot be read is treated as a spent cap (fail closed);
 * - a call's cost is the provider's reported usage times the model's price. A call whose cost is unknown (a server error, a cut
 *   connection, a timeout, an abort, an answer with no usage) is charged at its ceiling, so failed and partial calls always count;
 * - the cap is `MAX_API_DAILY_USD` in code. Configuration can only lower it; raising it is a reviewed code change (CODING_STANDARDS 4).
 *
 * The caller (the judge and propose passes) runs ApiBrain under an open `brain_runs` row, and the `spentUsd` it is given counts that
 * row at its ceiling while the call is in flight, so concurrent and crashed calls are in the figure too.
 *
 * The key is held in a private field, handed to the SDK client and nowhere else: never logged, never in an error (errors are rebuilt
 * from the status code, with no cause chain and the key redacted), never in the environment of a child. The model's answer is
 * returned as raw text; the passes' strict parsers decide what is stored (CODING_STANDARDS 13).
 */

export const API_TASKS = ["judge", "propose"] as const;
export type ApiTask = (typeof API_TASKS)[number];
export const isApiTask = (task: string): task is ApiTask => (API_TASKS as readonly string[]).includes(task);

/** The most real money the API may spend in a rolling 24 hours. Raising it is a code change; configuration can only lower it. */
export const MAX_API_DAILY_USD = 0.5;

export const ANTHROPIC_API_URL = "https://api.anthropic.com";

/**
 * The API endpoint: `ARGUS_ANTHROPIC_URL` when set, else the real one. The test run points it at a loopback tripwire
 * (no-leaked-fakes.ts), so no test can reach the real API by accident. The SDK's own ANTHROPIC_BASE_URL is deliberately not read.
 */
export function anthropicBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.ARGUS_ANTHROPIC_URL?.trim() || ANTHROPIC_API_URL;
}

export interface ModelPrice {
  /** US dollars per million tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Prompts above this many tokens are priced differently; they are refused, never priced as if cheap. */
  maxPromptTokens: number;
}

/** Prices of the models ApiBrain may use (claude-api skill, 2026-10-06): a model not listed here cannot be configured. */
export const API_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, maxPromptTokens: 100_000 },
};

export interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

function priceOf(model: string): ModelPrice {
  const price = API_PRICES[model];
  if (!price) throw new Error(`The API model "${model}" has no known price; add it to API_PRICES before using it`);
  return price;
}

/**
 * The real dollars of a call, from the provider's reported usage. Cache tokens are charged at the dearest rate they can have (cache
 * writes at 1.25 x input, cache reads at the full input rate), never less. Throws on a usage that is missing or not plain numbers.
 */
export function apiCostUsd(model: string, usage: ApiUsage | null | undefined): number {
  const price = priceOf(model);
  if (!usage) throw new Error("the response reports no usage");
  const n = (v: number | null | undefined, name: string): number => {
    if (v === undefined || v === null) return 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`usage.${name} is not a plain count`);
    return v;
  };
  const input = n(usage.input_tokens, "input_tokens");
  const output = n(usage.output_tokens, "output_tokens");
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) throw new Error("the response reports incomplete usage");
  const cacheWrite = n(usage.cache_creation_input_tokens, "cache_creation_input_tokens");
  const cacheRead = n(usage.cache_read_input_tokens, "cache_read_input_tokens");
  return ((input + cacheWrite * 1.25 + cacheRead) * price.inputPerMTok + output * price.outputPerMTok) / 1e6;
}

export interface ApiRoute {
  /** An exact model id with a price in `API_PRICES`. */
  model: string;
  /** `max_tokens` of the request: the most the answer can cost, so it bounds the ceiling. */
  maxTokens: number;
  /** A call whose ceiling is over this is refused before it is made (the API's counterpart of `--max-budget-usd`). */
  maxBudgetUsd: number;
  timeoutMs: number;
}

/**
 * Haiku, small answers, small per-run caps. The most a judge call can cost (its biggest prompt, about 17 KB, plus 1024 answer tokens)
 * is about a fifth of a cent and a propose call's about a third of a cent, so these caps leave a wide margin; they are also what an
 * API run still in flight, or one that ended with no cost, is charged against the daily cap.
 */
export const API_DEFAULT_ROUTING: Record<ApiTask, ApiRoute> = {
  judge: { model: "claude-haiku-5-5", maxTokens: 1024, maxBudgetUsd: 0.01, timeoutMs: 60_000 },
  propose: { model: "claude-haiku-5-5", maxTokens: 2048, maxBudgetUsd: 0.02, timeoutMs: 120_000 },
};

/** Tokens added on top of the byte length of the prompt when bounding its token count: a token is at least a byte of UTF-8. */
const FRAMING_TOKENS = 64;

/** The most one call can cost: every prompt byte as an input token, and the whole `max_tokens` as output. */
export function callCeilingUsd(route: ApiRoute, promptBytes: number): number {
  const price = priceOf(route.model);
  return ((promptBytes + FRAMING_TOKENS) * price.inputPerMTok + route.maxTokens * price.outputPerMTok) / 1e6;
}

/** The slice of the SDK client ApiBrain uses; tests may inject one instead of a real client. */
export interface ApiClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        system: string;
        messages: Array<{ role: "user"; content: string }>;
        thinking: { type: "disabled" };
      },
      options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
    ): Promise<{ content: Array<{ type: string; text?: string }>; stop_reason?: string | null; usage?: ApiUsage | null }>;
  };
}

export interface ApiBrainOptions {
  /** The Anthropic API key. Not needed for a dry run or with an injected `client`. */
  apiKey?: string;
  /** Endpoint; default `anthropicBaseUrl()`. */
  baseUrl?: string;
  /** For tests: used instead of building an SDK client. */
  client?: ApiClient;
  /** Directory holding `<task>/SKILL.md` (normally argus's `.claude/skills`). */
  skillsDir: string;
  routing?: Partial<Record<ApiTask, ApiRoute>>;
  /** Real dollars spent in the last 24 hours, in-flight and unknown-cost calls charged at their ceiling. Throwing counts as a spent cap. */
  spentUsd: () => number;
  /** The daily cap in real dollars: positive and at most `MAX_API_DAILY_USD`. Default `MAX_API_DAILY_USD`. */
  dailyCapUsd?: number;
  /** Log the request and send nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** A key is a plain token: printable ASCII, no spaces. Anything else could smuggle a header and is refused without being echoed. */
const KEY_RE = /^[\x21-\x7e]{8,512}$/;
const SECRET_RE = /(?:sk-ant-|Bearer\s+)[A-Za-z0-9_\-.=]+/g;

/** The run was held back by the daily real-dollar cap. It stops the pass and leaves the work queued (`rate-limited`), and nothing was sent. */
export class ApiSpendCapError extends BrainError {
  constructor(message: string, model: string) {
    super("rate-limited", message, { backend: "api", model });
    this.name = "ApiSpendCapError";
  }
}

export class ApiBrain implements Brain {
  #client: ApiClient | undefined;
  readonly #key: string | undefined;
  readonly #routing: Record<ApiTask, ApiRoute>;
  readonly #cap: number;
  readonly #spent: () => number;
  readonly #skillsDir: string;
  readonly #dryRun: boolean;
  readonly #baseUrl: string;
  readonly #log: (line: string) => void;

  constructor(o: ApiBrainOptions) {
    this.#routing = { ...API_DEFAULT_ROUTING, ...o.routing };
    for (const task of API_TASKS) priceOf(this.#routing[task].model);
    const cap = o.dailyCapUsd ?? MAX_API_DAILY_USD;
    if (!Number.isFinite(cap) || cap <= 0) throw new Error(`The API daily cap must be a positive number of dollars, got ${cap}`);
    if (cap > MAX_API_DAILY_USD) throw new Error(`The API daily cap must be at most $${MAX_API_DAILY_USD} (a hard cap in code), got ${cap}`);
    this.#cap = cap;
    this.#spent = o.spentUsd;
    this.#skillsDir = o.skillsDir;
    this.#dryRun = o.dryRun ?? false;
    this.#baseUrl = (o.baseUrl ?? anthropicBaseUrl()).replace(/\/+$/, "");
    this.#log = o.log ?? console.log;
    if (o.apiKey !== undefined && !KEY_RE.test(o.apiKey)) throw new Error("ANTHROPIC_API_KEY is not a plain token (printable characters, no spaces); fix it in .env");
    this.#key = o.apiKey;
    if (o.client) this.#client = o.client;
    else if (!this.#dryRun && this.#key === undefined) throw new Error("ApiBrain needs ANTHROPIC_API_KEY");
  }

  /**
   * The SDK client, built on the first call. The SDK is imported only then, so a process that never calls the API (the War Room, a worker
   * with the fallback off or idle) never loads it. Everything the SDK would otherwise read from the environment is given explicitly: the
   * key, the endpoint, no retries (a retry is a second bill), no SDK logging, and no auth token, so ANTHROPIC_AUTH_TOKEN is not read.
   */
  async #getClient(): Promise<ApiClient> {
    if (!this.#client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.#client = new Anthropic({ apiKey: this.#key, authToken: null, baseURL: this.#baseUrl, maxRetries: 0, logLevel: "off" }) as unknown as ApiClient;
    }
    return this.#client;
  }

  /** The route of an API task; any other task is not an API task. */
  routeFor(task: BrainTask): { backend: BrainBackend; model: string; maxBudgetUsd: number } {
    if (!isApiTask(task)) throw new BrainError("failed", `Only judge and propose can run on the API, not ${task}`, { backend: "api", model: this.#routing.judge.model });
    const { model, maxBudgetUsd } = this.#routing[task];
    return { backend: "api", model, maxBudgetUsd };
  }

  async run<T = string>(task: BrainTask, input: BrainInput, opts: BrainRunOptions = {}): Promise<BrainRun<T>> {
    const { model, maxBudgetUsd } = this.routeFor(task); // refuses spec and build
    const route = this.#routing[task as ApiTask];
    const info = { backend: "api" as const, model };
    if (input.slash !== undefined) throw new BrainError("failed", "The API backend takes no custom skill", info);
    const system = this.#systemPrompt(task as ApiTask);
    const user = input.prompt;
    if (this.#dryRun) {
      this.#log(`[brain] dry-run: POST ${this.#baseUrl}/v1/messages model=${model} max_tokens=${route.maxTokens} system=${system.length} chars prompt=${JSON.stringify(user.slice(0, 200))}`);
      return { output: "" as T, totalCostUsd: 0, dryRun: true, ...info };
    }
    if (opts.signal?.aborted) throw new BrainError("interrupted", "Run not started: the worker is stopping", info);
    const ceiling = callCeilingUsd(route, Buffer.byteLength(system) + Buffer.byteLength(user));
    if (ceiling > maxBudgetUsd || Buffer.byteLength(system) + Buffer.byteLength(user) + FRAMING_TOKENS > priceOf(model).maxPromptTokens) {
      throw new BrainError("budget-exceeded", `The API call could cost up to $${ceiling.toFixed(4)}, over its $${maxBudgetUsd} cap; not sent`, info);
    }
    let spent: number;
    try {
      spent = this.#spent();
    } catch {
      throw new BrainError("failed", "Could not read today's API spend; not calling the API (fail closed)", info);
    }
    if (!Number.isFinite(spent) || spent < 0) throw new BrainError("failed", "Today's API spend is not a plain number; not calling the API (fail closed)", info);
    if (spent + ceiling > this.#cap) {
      this.#log(`[api] daily cap reached ($${spent.toFixed(4)} spent of $${this.#cap.toFixed(2)}, this call could cost up to $${ceiling.toFixed(4)}); not calling the API`);
      throw new ApiSpendCapError(`The API daily cap of $${this.#cap.toFixed(2)} is reached ($${spent.toFixed(4)} spent); waiting for older spend to leave the 24 hours`, model);
    }

    let message;
    try {
      const client = await this.#getClient();
      message = await client.messages.create(
        { model, max_tokens: route.maxTokens, system, messages: [{ role: "user", content: user }], thinking: { type: "disabled" } },
        { signal: opts.signal, timeout: route.timeoutMs, maxRetries: 0 },
      );
    } catch (e) {
      throw this.#failure(e, opts.signal, ceiling, info);
    }
    let cost: number;
    try {
      cost = apiCostUsd(model, message.usage);
    } catch {
      cost = ceiling; // the provider did not say what it used: charged at the most it could have
    }
    this.#log(`[api] ${task}: ${message.usage?.input_tokens ?? "?"} tokens in, ${message.usage?.output_tokens ?? "?"} out, $${cost.toFixed(6)}`);
    const text = (message.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (text.trim() === "") {
      throw new BrainError("failed", `The API answered with no text (stop reason ${this.#plain(message.stop_reason)})`, { ...info, totalCostUsd: cost });
    }
    return { output: text as T, totalCostUsd: cost, ...info };
  }

  #systemPrompt(task: ApiTask): string {
    const raw = readFileSync(join(this.#skillsDir, task, "SKILL.md"), "utf8");
    const skill = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    return `${skill}\n\n## How this run differs\n\nThis run is a single API request, not Claude Code: you have no tools (no WebSearch, WebFetch or file access), and the input is the user message, with no \`/${task}\` line. Where the instructions above mention using tools, skip that and work from the input alone; take evidence links only from the input. Your whole reply must still be the one JSON object described above.`;
  }

  /** A short, fixed-vocabulary word for a value the server sent, so nothing it echoes reaches a message. */
  #plain(v: unknown): string {
    return typeof v === "string" && /^[a-z_]{1,32}$/.test(v) ? v : "unknown";
  }

  /** The failure as a BrainError built from the status alone: no response body, no cause chain, no key. */
  #failure(e: unknown, signal: AbortSignal | undefined, ceiling: number, info: { backend: "api"; model: string }): BrainError {
    // The SDK's errors are recognised by name and status, not by class: the SDK is loaded lazily, and nothing else of the error is read.
    const err = (typeof e === "object" && e !== null ? e : {}) as { status?: unknown; error?: { error?: { type?: unknown } } };
    const className = (e as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
    if (signal?.aborted || className === "APIUserAbortError") {
      return new BrainError("interrupted", "The API call was aborted because the worker is stopping", { ...info, totalCostUsd: ceiling });
    }
    const status = typeof err.status === "number" ? err.status : undefined;
    const type = this.#plain(err.error?.error?.type);
    if (status === 429) return new BrainError("rate-limited", `The API rate-limited the request (HTTP 429, ${type})`, { ...info, totalCostUsd: 0 });
    if (status !== undefined && status >= 400 && status < 500) {
      // The request was rejected outright: it was not served, so it was not billed.
      return new BrainError("failed", this.#redact(`The API rejected the request (HTTP ${status}, ${type})`), { ...info, totalCostUsd: 0 });
    }
    const what = status !== undefined ? `HTTP ${status}, ${type}` : className === "APIConnectionTimeoutError" ? "timed out" : "no answer";
    return new BrainError("failed", this.#redact(`The API call failed (${what}); charged at its ceiling because its cost is unknown`), { ...info, totalCostUsd: ceiling });
  }

  #redact(text: string): string {
    let out = text;
    if (this.#key) for (const k of new Set([this.#key, encodeURIComponent(this.#key)])) out = out.split(k).join("[redacted]");
    return out.replace(SECRET_RE, "[redacted]");
  }
}
