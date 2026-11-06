import { HttpError } from "./http.ts";
import type { Signal, Source } from "./source.ts";

export interface BackoffOptions {
  /** Wait after the first failure; doubles on each further one. Default 10 minutes. */
  baseMs?: number;
  /** No wait is longer than this, a server's Retry-After included. Default 1 hour. */
  maxMs?: number;
  now?: () => number;
}

/**
 * Keeps a rate-limited or failing Source from being hammered. A failure is rethrown (so the ingest pass logs it once) and the
 * Source is then left alone until its wait is over; polls in between return nothing. A success clears the wait.
 * It only works on a Source object that outlives the ingest pass.
 */
export class BackoffSource implements Source {
  readonly id: string;
  readonly label: string;
  private failures = 0;
  private blockedUntil = 0;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;
  private readonly inner: Source;

  constructor(inner: Source, opts: BackoffOptions = {}) {
    this.inner = inner;
    this.id = inner.id;
    this.label = inner.label;
    this.baseMs = opts.baseMs ?? 10 * 60_000;
    this.maxMs = opts.maxMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async poll(): Promise<Signal[]> {
    if (this.now() < this.blockedUntil) return [];
    try {
      const signals = await this.inner.poll();
      this.failures = 0;
      return signals;
    } catch (e) {
      this.failures++;
      const exponential = this.baseMs * 2 ** Math.min(this.failures - 1, 20);
      const asked = e instanceof HttpError ? (e.retryAfterMs ?? 0) : 0;
      this.blockedUntil = this.now() + Math.min(Math.max(exponential, asked), this.maxMs);
      throw e;
    }
  }
}
