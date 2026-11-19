/**
 * Settings of the chain-sourced creates job (phase 3 ticket 20). The credit cap and the sample size come from the ticket; the budget
 * arithmetic is there: 25,000 a day is 750k a month at 30 days, leaving about 250k of the Free plan's 1M for tickets 03, 04 and 10, which
 * use the same key. The environment may lower the cap or set it up to the hard ceiling; going past the ceiling is a reviewed code change.
 */

export const DEFAULT_DAILY_CREDIT_CAP = 25_000;
/** 33,000 a day is about 990k in a 30-day month: past this the month breaks the Free plan. */
export const MAX_DAILY_CREDIT_CAP = 33_000;
export const DEFAULT_SAMPLE_SIZE = 2_000;
export const MAX_SAMPLE_SIZE = 10_000;
/** The Free plan allows 10 requests a second; this leaves room for the other tickets' jobs on the same key. */
export const REQUESTS_PER_SECOND = 8;
/** Days back, besides yesterday, for which a missed daily sample is still drawn. */
export const SAMPLE_CATCH_UP_DAYS = 1;

export interface ChainCreatesConfig {
  /** The Helius key from the environment (`HELIUS_API_KEY`); undefined when not set, which turns the job off. Never logged. */
  apiKey: string | undefined;
  chainCreatesDailyCreditCap: number;
  chainCreatesSampleSize: number;
  requestsPerSecond: number;
}

const whole = (raw: string | undefined): number | undefined => (raw && /^\d{1,9}$/.test(raw) ? Number(raw) : undefined);

/** Reads the settings from `env` (default `process.env`); junk or out-of-range values fall back to the default, never past the ceilings. */
export function chainCreatesConfig(env: Record<string, string | undefined> = process.env): ChainCreatesConfig {
  const cap = whole(env.ARGUS_CHAIN_CREATES_DAILY_CREDIT_CAP);
  const size = whole(env.ARGUS_CHAIN_CREATES_SAMPLE_SIZE);
  const key = env.HELIUS_API_KEY?.trim();
  return {
    apiKey: key ? key : undefined,
    chainCreatesDailyCreditCap: cap !== undefined && cap >= 1 ? Math.min(MAX_DAILY_CREDIT_CAP, cap) : DEFAULT_DAILY_CREDIT_CAP,
    chainCreatesSampleSize: size !== undefined && size >= 1 ? Math.min(MAX_SAMPLE_SIZE, size) : DEFAULT_SAMPLE_SIZE,
    requestsPerSecond: REQUESTS_PER_SECOND,
  };
}
