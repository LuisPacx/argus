import type { Datastore } from "../datastore.ts";
import { META_RULE } from "../meta/config.ts";
import type { MetaCoverage } from "../meta/coverage.ts";
import type { CurrentGrads, CurrentMeta, CurrentTheme, MetaCounts, NewMetaRow } from "../meta/store.ts";

/**
 * Fixtures for tests of what reads the market-led Metas (ADR 0014): a Meta or Watching subject with a leader token and a stored run that
 * carries them. Test code only; the worker never imports this.
 */

const counts = (tokens: number, creators: number): MetaCounts => ({ tokens, creators, migrations: Math.floor(tokens / 4), migrationsAfter60s: Math.floor(tokens / 10) });

export interface AMetaOptions {
  label?: string;
  /** The leader's market cap, USD. */
  cap?: number;
  leaderName?: string;
  leaderSymbol?: string;
  leaderMint?: string;
  /** Distinct creators in 24 h. */
  creators?: number;
  tokens?: number;
  enteredAt?: string;
  holding?: boolean;
  topTokens?: CurrentMeta["topTokens"];
  /** The merged launch themes (ticket 06); none by default, a subject named by rules. */
  themes?: CurrentTheme[];
  namedBy?: "ai" | "rules";
  /** The subject's graduations (graduation Meta ticket 01); none by default, like a row stored before graduation Metas. */
  grads?: CurrentGrads;
}

/** A Meta (or Watching subject) with a leader token; the numbers are plausible and the strings are what a creator might write. */
export function aMeta(key: string, o: AMetaOptions = {}): CurrentMeta {
  const creators = o.creators ?? 14;
  const tokens = o.tokens ?? creators * 2;
  const symbol = o.leaderSymbol ?? key.toUpperCase().slice(0, 8);
  const mint = o.leaderMint ?? `${key}Mint`.padEnd(40, "L") + "pump";
  return {
    key,
    label: o.label ?? key,
    ...(o.namedBy !== undefined ? { namedBy: o.namedBy } : {}),
    ...(o.themes !== undefined ? { themes: o.themes } : {}),
    ...(o.grads !== undefined ? { grads: o.grads } : {}),
    leader: { mint, name: o.leaderName ?? `${key} leader`, symbol, marketCapUsd: o.cap ?? 2_400_000, source: "trending", stale: false, freshAt: "2026-11-15T12:00:00.000Z" },
    holding: o.holding ?? false,
    enteredAt: o.enteredAt ?? "2026-11-15T10:00:00.000Z",
    counts: { "6h": counts(Math.ceil(tokens / 3), Math.ceil(creators / 2)), "24h": counts(tokens, creators) },
    topTokens: o.topTokens ?? [{ mint, name: o.leaderName ?? `${key} leader`, symbol, marketCapUsd: o.cap ?? 2_400_000 }],
  };
}

export const FULL_COVERAGE: MetaCoverage = { "6h": { covered: 6, of: 6 }, "24h": { covered: 24, of: 24 } };

/** Stores a run at `at` whose Metas and Watching subjects are the given ones; returns the run id. The launch-theme rows are `rows` (none by default). */
export function saveCurrentRun(store: Datastore, at: Date | string, current: { metas?: CurrentMeta[]; watching?: CurrentMeta[] }, opts: { rows?: NewMetaRow[]; coverage?: MetaCoverage | null } = {}): number {
  const rows = opts.rows ?? [];
  return store.meta.saveRun({
    computedAt: typeof at === "string" ? at : at.toISOString(),
    note: "test run",
    rule: META_RULE,
    dexCalls: 0,
    dexFailures: 0,
    base: { "6h": { tokens: 0, migrations: 0 }, "24h": { tokens: 0, migrations: 0 } },
    rows: { "6h": rows, "24h": rows },
    // null: no coverage stored, like a run from before ticket 05.
    ...(opts.coverage === null ? {} : { coverage: opts.coverage ?? FULL_COVERAGE }),
    current: { metas: current.metas ?? [], watching: current.watching ?? [] },
  });
}
