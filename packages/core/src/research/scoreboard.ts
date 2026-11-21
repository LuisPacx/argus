import type { DatabaseSync } from "node:sqlite";
import { bondingStats, OUTCOME_WEEK_MS, pickItemOf, type BondingStats, type OutcomeResult } from "./pick-outcomes.ts";
import { cleanTopic, type PickSource } from "./picks.ts";

/**
 * The Scoreboard (human researcher ticket 08, ADR 0017): the Operator's and the machine's bonded-within-24h rate over the last 7 days, each with n.
 * Plain code, no model. Both sides are scored by `bondingStats` over the same outcome rows (ticket 04), so the rule for an already-bonded or an unknown
 * coin is one rule. The comparison is fair by construction:
 *  - same candidate set: an Operator Pick is compared only when its coin was in the coin list of a brief for its topic (the list the machine chose from);
 *    the others are shown in a separate row and never counted in the comparison;
 *  - like with like: only topics on which both sides made a Pick are compared, and each side is counted over exactly those topics;
 *  - n is the number of Picks that count in the rate (finished, not already bonded, not unknown), and no verdict is drawn while either side has fewer
 *    than `SCOREBOARD_MIN_PICKS` of them.
 */

/** The verdict threshold: finished Picks needed on EACH side before the Scoreboard names a leader. Shown on the page too. */
export const SCOREBOARD_MIN_PICKS = 20;
export const SCOREBOARD_WINDOW_DAYS = 7;
export const SCOREBOARD_WINDOW_MS = OUTCOME_WEEK_MS;

export type ScoreboardVerdict =
  /** Either side has fewer than `SCOREBOARD_MIN_PICKS` finished Picks: no leader is named. */
  | { kind: "not-enough"; text: string }
  | { kind: "machine" | "operator" | "level"; text: string };

export interface Scoreboard {
  windowDays: number;
  minPicks: number;
  /** The compared Picks: same topics, Operator Picks only from a brief's coin list. */
  operator: BondingStats;
  machine: BondingStats;
  /** The topics compared (as first typed), sorted. */
  topics: string[];
  /** Operator Picks left out of the comparison (the coin was in no brief list for the topic, no topic, or the machine made no pick on the topic), shown on their own. */
  operatorOutside: BondingStats;
  /** Shadow picks on topics where the Operator made no comparable Pick, shown on their own. */
  machineOutside: BondingStats;
  verdict: ScoreboardVerdict;
}

/** One Pick of the window with its outcome, as the Scoreboard reads it. */
export interface ScoreItem {
  source: PickSource;
  ca: string;
  /** The Pick's topic as stored ("" for none). */
  topic: string;
  over: boolean;
  result: OutcomeResult;
}

/** The key two topics are compared by: cleaned the way a Pick stores it, then lower-cased. */
export const scoreTopicKey = (topic: string): string => cleanTopic(topic).toLowerCase();

const pct = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;

/** The verdict from the two sides' counted Picks. Pure; `SCOREBOARD_MIN_PICKS` is checked here and nowhere else. */
export function verdictOf(operator: BondingStats, machine: BondingStats): ScoreboardVerdict {
  if (operator.finished < SCOREBOARD_MIN_PICKS || machine.finished < SCOREBOARD_MIN_PICKS || operator.rate === null || machine.rate === null) {
    return { kind: "not-enough", text: `Not enough Picks yet: a verdict needs ${SCOREBOARD_MIN_PICKS} finished Picks on each side (Operator ${operator.finished}, machine ${machine.finished}).` };
  }
  if (machine.rate > operator.rate) return { kind: "machine", text: `The machine is ahead: ${pct(machine.rate)} against ${pct(operator.rate)}.` };
  if (operator.rate > machine.rate) return { kind: "operator", text: `The Operator is ahead: ${pct(operator.rate)} against ${pct(machine.rate)}.` };
  return { kind: "level", text: `Level: both at ${pct(operator.rate)}.` };
}

/**
 * The Scoreboard over the Picks of the window. `briefLists` maps a topic key to the set of coin addresses that appeared in the coin list of any brief for that
 * topic. Pure.
 */
export function buildScoreboard(items: readonly ScoreItem[], briefLists: ReadonlyMap<string, ReadonlySet<string>>): Scoreboard {
  const inList = (i: ScoreItem): boolean => {
    const key = scoreTopicKey(i.topic);
    return key !== "" && briefLists.get(key)?.has(i.ca) === true;
  };
  const operatorEligible = items.filter((i) => i.source === "operator" && inList(i));
  const shadow = items.filter((i) => i.source === "shadow" && scoreTopicKey(i.topic) !== "");
  const shadowTopics = new Set(shadow.map((i) => scoreTopicKey(i.topic)));
  const compared = new Set(operatorEligible.map((i) => scoreTopicKey(i.topic)).filter((k) => shadowTopics.has(k)));
  const isCompared = (i: ScoreItem) => compared.has(scoreTopicKey(i.topic));
  const operatorIn = operatorEligible.filter(isCompared);
  const machineIn = shadow.filter(isCompared);
  const operator = bondingStats(operatorIn);
  const machine = bondingStats(machineIn);
  const label = new Map<string, string>();
  for (const i of [...operatorIn, ...machineIn]) if (!label.has(scoreTopicKey(i.topic))) label.set(scoreTopicKey(i.topic), cleanTopic(i.topic));
  return {
    windowDays: SCOREBOARD_WINDOW_DAYS,
    minPicks: SCOREBOARD_MIN_PICKS,
    operator,
    machine,
    topics: [...label.values()].sort((a, b) => a.localeCompare(b)),
    operatorOutside: bondingStats(items.filter((i) => i.source === "operator" && !operatorIn.includes(i))),
    machineOutside: bondingStats(items.filter((i) => i.source === "shadow" && !machineIn.includes(i))),
    verdict: verdictOf(operator, machine),
  };
}

type Row = Record<string, string | number | null>;

/** The Scoreboard as of `now`, read from the database. READ ONLY. */
export function loadScoreboard(db: DatabaseSync, now: Date): Scoreboard {
  const nowMs = now.getTime();
  const rows = db
    .prepare("SELECT p.ca, p.source, p.topic, p.created_at, p.bonded_at_pick, o.result AS o_result FROM picks p LEFT JOIN pick_outcomes o ON o.pick_id = p.id WHERE p.created_at > ?")
    .all(new Date(nowMs - SCOREBOARD_WINDOW_MS).toISOString()) as Row[];
  const items: ScoreItem[] = rows.map((r) => {
    const { over, result } = pickItemOf(r, nowMs);
    return { source: r.source as PickSource, ca: r.ca as string, topic: r.topic as string, over, result };
  });
  const lists = new Map<string, Set<string>>();
  const briefs = db.prepare("SELECT r.topic AS topic, b.coins AS coins FROM research_briefs b JOIN research_requests r ON r.id = b.request_id").all() as Row[];
  for (const b of briefs) {
    const key = scoreTopicKey(String(b.topic));
    let coins: unknown;
    try {
      coins = JSON.parse(String(b.coins));
    } catch {
      continue;
    }
    if (key === "" || !Array.isArray(coins)) continue;
    const set = lists.get(key) ?? new Set<string>();
    for (const c of coins) if (typeof c === "object" && c !== null && typeof (c as { ca?: unknown }).ca === "string") set.add((c as { ca: string }).ca);
    lists.set(key, set);
  }
  return buildScoreboard(items, lists);
}
