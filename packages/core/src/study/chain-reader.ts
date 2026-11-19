import type { ChainJob } from "./chain-store.ts";
import { utcDay } from "./chain-store.ts";
import { MINT_AUTHORITY_PDA } from "./chain-create.ts";
import {
  CREDIT_COST,
  SIGNATURES_VERB,
  TXS_FOR_ADDRESS_VERB,
  TX_VERB,
  getSignaturesForAddress,
  getTransaction,
  getTransactionsForAddress,
  historyCost,
  type HeliusClient,
  type ParsedTransaction,
  type SignatureInfo,
} from "./helius.ts";

/**
 * The job's only way to the chain: the `helius.ts` wrappers behind a request rate limiter and a credit meter. Before each call the
 * cost is added to the day's total from the cost table (counted in code, never read back); a call that would pass the daily cap is not
 * made and `CreditCapReached` is thrown, so a job stops between calls and never half-way through one.
 */

export class CreditCapReached extends Error {
  readonly spent: number;
  readonly cap: number;
  constructor(spent: number, cap: number) {
    super(`the daily credit cap of ${cap} is reached (${spent} spent)`);
    this.name = "CreditCapReached";
    this.spent = spent;
    this.cap = cap;
  }
}

/** At most `perSecond` requests in any 1000 ms, by the injected clock; waits with the injected sleep. */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private readonly perSecond: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(perSecond: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.perSecond = Math.max(1, Math.floor(perSecond));
    this.now = now;
    this.sleep = sleep;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.stamps.length > 0 && this.stamps[0]! <= t - 1000) this.stamps.shift();
      if (this.stamps.length < this.perSecond) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(Math.max(1, this.stamps[0]! + 1000 - t));
    }
  }
}

export interface CreditLedger {
  creditsOnDay(day: string): number;
  recordCredits(day: string, runId: number, job: ChainJob, verb: string, credits: number): void;
}

export interface ChainReaderOptions {
  client: HeliusClient;
  ledger: CreditLedger;
  runId: number;
  dailyCap: number;
  limiter: RateLimiter;
  now?: () => Date;
}

export class ChainReader {
  /** Credits this reader has spent, by job. */
  readonly spent: Record<ChainJob, number> = { migrated_creates: 0, sample_listing: 0, sample_reads: 0 };
  private readonly o: ChainReaderOptions;

  constructor(options: ChainReaderOptions) {
    this.o = options;
  }

  private now(): Date {
    return this.o.now ? this.o.now() : new Date();
  }

  /** Waits for the rate limit, checks the cap for `cost`, runs `call`, and records the cost once it has answered (an error costs nothing). */
  private async metered<T>(job: ChainJob, verb: string, cost: number, call: () => Promise<T>): Promise<T> {
    const day = utcDay(this.now());
    const spent = this.o.ledger.creditsOnDay(day);
    if (spent + cost > this.o.dailyCap) throw new CreditCapReached(spent, this.o.dailyCap);
    await this.o.limiter.acquire();
    const out = await call();
    this.o.ledger.recordCredits(utcDay(this.now()), this.o.runId, job, verb, cost);
    this.spent[job] += cost;
    return out;
  }

  /** One page of successful and failed signatures of the mint-authority address, newest first (1 credit). */
  signaturesPage(before: string | undefined): Promise<SignatureInfo[]> {
    return this.metered("sample_listing", SIGNATURES_VERB, CREDIT_COST.signaturesPage, () => getSignaturesForAddress(this.o.client, MINT_AUTHORITY_PDA, { before }));
  }

  /** One transaction by signature (1 credit); null when the node does not have it. */
  transaction(signature: string): Promise<ParsedTransaction | null> {
    return this.metered("sample_reads", TX_VERB, CREDIT_COST.transaction, () => getTransaction(this.o.client, signature));
  }

  /**
   * A mint's earliest successful transaction, whole: the history call in ascending order with a limit of 1 (10 credits, the minimum, and
   * no second read). Settled by measurement on 12 migrated mints: paging back through signatures cost 3 to 26+ credits each and
   * was unbounded (two mints passed 25 pages), this costs 10 flat and always returned the create (fixtures/helius-earliest-tx-measurement.json).
   */
  async earliestTransaction(mint: string): Promise<ParsedTransaction | null> {
    const h = await this.metered("migrated_creates", TXS_FOR_ADDRESS_VERB, historyCost("full", 1), () =>
      getTransactionsForAddress(this.o.client, mint, { sortOrder: "asc", limit: 1, detail: "full", status: "succeeded" }),
    );
    return h.data[0] ?? null;
  }
}
