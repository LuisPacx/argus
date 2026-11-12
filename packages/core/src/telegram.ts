import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { Datastore, Proposal } from "./datastore.ts";

/**
 * Telegram notifications: one bot, one Team chat, notify only (docs/architecture.md). Messages go out as plain text with no
 * parse mode, so Proposal names and texts (untrusted, CODING_STANDARDS 13) need no escaping and cannot inject markup.
 *
 * Sending never blocks the caller: `notify` puts the text on a bounded queue and returns; one background sender works it off,
 * retrying with backoff. The bot token is part of the Bot API URL path, so every error text is redacted before it is logged.
 */

export const TELEGRAM_MAX_TEXT = 4096;
const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_BACKOFF_MS = [2_000, 10_000, 60_000];

export interface TelegramConfig {
  token: string;
  chatId: string;
}

/** The bot token and chat id from the environment (the git-ignored `.env`); undefined unless both are set. */
export function telegramConfigFromEnv(env: NodeJS.ProcessEnv): TelegramConfig | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : undefined;
}

const TELEGRAM_ENV_NAMES = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;

/**
 * The two Telegram variables: from `env`, else from the .env file at `envFile`. A variable that is set, even to the empty
 * string, wins over the file (so a test can mask the file with ""). With `ARGUS_NO_DOTENV` set the file is never read: the test
 * run sets it, so a test never reads the Operator's .env (CODING_STANDARDS 16).
 */
export function telegramEnv(env: NodeJS.ProcessEnv, envFile: string): NodeJS.ProcessEnv {
  return dotenvPick(TELEGRAM_ENV_NAMES, env, envFile);
}

/** The Cloudflare credentials a Build needs, read the same way as `telegramEnv`: from `env`, else from the .env file. Nothing else is taken. */
export function cloudflareEnv(env: NodeJS.ProcessEnv, envFile: string): NodeJS.ProcessEnv {
  return dotenvPick(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], env, envFile);
}

/** Only the named variables: from `env`, else from the .env file at `envFile` (same rules as `telegramEnv`). Nothing else leaves the file. */
function dotenvPick(names: readonly string[], env: NodeJS.ProcessEnv, envFile: string): NodeJS.ProcessEnv {
  let file: Record<string, string | undefined> = {};
  if (!env.ARGUS_NO_DOTENV && existsSync(envFile)) file = parseEnv(readFileSync(envFile, "utf8"));
  const out: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const v = env[name] !== undefined ? env[name] : file[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** `text` with the token (raw or URL-encoded) and any `/bot<token>` path segment replaced. */
export function redactToken(text: string, token: string): string {
  let out = text;
  for (const t of new Set([token, encodeURIComponent(token)])) if (t) out = out.split(t).join("[redacted]");
  return out.replace(/\/bot[^/\s"']+/g, "/bot[redacted]");
}

export interface Notifier {
  /** False when nothing will be sent (no config). */
  readonly enabled: boolean;
  /** Queues a message and returns at once. Never throws. */
  notify(text: string): void;
}

export interface TelegramNotifierOptions extends TelegramConfig {
  /** Tests point this at a loopback fake; default is the real Bot API. */
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Wait before each retry; its length is the number of retries. */
  backoffMs?: readonly number[];
  /** Messages waiting to be sent; when full the oldest is dropped. Default 50. */
  maxQueue?: number;
  requestTimeoutMs?: number;
  /** For tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

type Attempt = { ok: true } | { ok: false; retry: boolean; waitMs?: number; reason: string };

export class TelegramNotifier implements Notifier {
  readonly enabled = true;
  private readonly queue: string[] = [];
  private readonly stop = new AbortController();
  private sending: Promise<void> | undefined;
  private warnedFull = false;
  private readonly log: (line: string) => void;
  private readonly backoff: readonly number[];
  private readonly maxQueue: number;
  private readonly doFetch: typeof fetch;
  private readonly o: TelegramNotifierOptions;

  constructor(o: TelegramNotifierOptions) {
    this.o = o;
    this.log = o.log ?? console.log;
    this.backoff = o.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxQueue = o.maxQueue ?? 50;
    this.doFetch = o.fetch ?? fetch;
  }

  notify(text: string): void {
    if (this.stop.signal.aborted) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      if (!this.warnedFull) {
        this.warnedFull = true;
        this.log(`[telegram] queue full (${this.maxQueue}): dropping the oldest waiting message(s); Telegram is not keeping up`);
      }
    }
    this.queue.push(text.slice(0, TELEGRAM_MAX_TEXT));
    this.sending ??= this.drain();
  }

  /** Resolves once everything queued has been sent or given up on. */
  async idle(): Promise<void> {
    while (this.sending) await this.sending;
  }

  /** Drops what is waiting and abandons the request in flight. */
  close(): void {
    this.queue.length = 0;
    this.stop.abort();
  }

  private async drain(): Promise<void> {
    try {
      for (let text = this.queue.shift(); text !== undefined; text = this.queue.shift()) {
        this.warnedFull = false;
        await this.deliver(text);
      }
    } catch (e) {
      this.log(`[telegram] sender stopped: ${this.clean(e)}`);
    } finally {
      this.sending = undefined;
      if (this.queue.length > 0 && !this.stop.signal.aborted) this.sending = this.drain();
    }
  }

  private async deliver(text: string): Promise<void> {
    const sleep = this.o.sleep ?? realSleep;
    for (let n = 0; ; n++) {
      if (this.stop.signal.aborted) return;
      const r = await this.attempt(text);
      if (r.ok) return;
      if (!r.retry) return void this.log(`[telegram] message not sent: ${r.reason}`);
      if (n >= this.backoff.length) return void this.log(`[telegram] giving up on a message after ${n + 1} attempts: ${r.reason}`);
      this.log(`[telegram] send failed (${r.reason}); retry ${n + 1} of ${this.backoff.length}`);
      await sleep(r.waitMs ?? this.backoff[n]!, this.stop.signal);
    }
  }

  private async attempt(text: string): Promise<Attempt> {
    const timeout = AbortSignal.timeout(this.o.requestTimeoutMs ?? 15_000);
    try {
      const res = await this.doFetch(`${this.o.baseUrl ?? DEFAULT_BASE_URL}/bot${this.o.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.o.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.any([timeout, this.stop.signal]),
      });
      if (res.ok) return { ok: true };
      let body: { description?: unknown; parameters?: { retry_after?: unknown } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // not JSON: the status alone
      }
      const reason = this.clean(`HTTP ${res.status}${typeof body.description === "string" ? ` ${body.description}` : ""}`);
      if (res.status === 429) {
        const after = Number(body.parameters?.retry_after);
        return { ok: false, retry: true, reason, waitMs: Number.isFinite(after) && after > 0 ? Math.min(after, 300) * 1000 : undefined };
      }
      return { ok: false, retry: res.status >= 500, reason };
    } catch (e) {
      return { ok: false, retry: !this.stop.signal.aborted, reason: this.clean(e) };
    }
  }

  private clean(e: unknown): string {
    const parts: string[] = [];
    let err: unknown = e;
    for (let depth = 0; err instanceof Error && depth < 10; depth++, err = err.cause) parts.push(depth === 0 ? `${err.name}: ${err.message}` : err.message);
    if (err !== undefined && !(err instanceof Error)) parts.push(String(err)); // a non-Error value, as the thrown value or as a cause
    if (parts.length === 0) parts.push(String(e));
    return redactToken(parts[0]! + (parts.length > 1 ? ` (${parts.slice(1).join(" <- ")})` : ""), this.o.token);
  }
}

const OFF: Notifier = { enabled: false, notify: () => {} };

export interface CreateNotifierOptions {
  env: NodeJS.ProcessEnv;
  dryRun?: boolean;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** A dry-run notifier: logs each message instead of sending it. */
class DryRunNotifier implements Notifier {
  readonly enabled = true;
  private readonly log: (line: string) => void;
  constructor(log: (line: string) => void) {
    this.log = log;
  }
  notify(text: string): void {
    this.log(`[telegram] dry-run: would send:\n${text}`);
  }
  async idle(): Promise<void> {}
}

/**
 * The notifier the worker uses. Missing config disables notifications with one warning (it names the variables, never a value).
 * `idle()` is available on the real and dry-run notifiers for tests and shutdown.
 */
export function createNotifier(o: CreateNotifierOptions): Notifier & { idle(): Promise<void>; close(): void } {
  const log = o.log ?? console.log;
  const config = telegramConfigFromEnv(o.env);
  if (!config) {
    log("[telegram] notifications are off: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable them");
    return Object.assign({ ...OFF }, { idle: async () => {}, close: () => {} });
  }
  if (o.dryRun) return Object.assign(new DryRunNotifier(log), { close: () => {} });
  return new TelegramNotifier({ ...config, log, fetch: o.fetch, baseUrl: o.baseUrl });
}

/** One line of untrusted text: control characters and runs of whitespace (line and paragraph separators included) collapsed, cut to `max`. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

export function newProposalText(p: Proposal): string {
  const lines = [
    `New Proposal: ${oneLine(p.name, 80)} ($${oneLine(p.ticker, 20)})`,
    `Narrative: ${oneLine(p.narrativeSummary, 300)}`,
    `Tech: ${oneLine(p.techOneLiner, 300)}`,
    `Why now: ${oneLine(p.whyNow, 300)}`,
    ...p.evidenceLinks.slice(0, 3).map((l) => `Evidence: ${oneLine(l, 200)}`),
  ];
  return lines.join("\n");
}

export const buildStartText = (p: Proposal): string => `Build started: ${oneLine(p.name, 80)} ($${oneLine(p.ticker, 20)})`;

export const buildDoneText = (p: Proposal): string =>
  `Build done: ${oneLine(p.name, 80)} ($${oneLine(p.ticker, 20)})${p.previewUrl ? `\nPreview: ${oneLine(p.previewUrl, 200)}` : ""}`;

export const buildFailedText = (p: Proposal, reason: string): string =>
  `Build failed: ${oneLine(p.name, 80)} ($${oneLine(p.ticker, 20)})\nReason: ${oneLine(reason, 300)}`;

/** Queues a card for every Proposal not announced yet, once each (the worker tick calls this). Returns how many. */
export function announceNewProposals(store: Datastore, notifier: Notifier): number {
  if (!notifier.enabled) return 0;
  const fresh = store.unannouncedNewProposals();
  for (const p of fresh) {
    store.markAnnounced(p.id);
    notifier.notify(newProposalText(p));
  }
  return fresh.length;
}
