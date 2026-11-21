import type { DatabaseSync } from "node:sqlite";
import { bondingStats, OUTCOME_WEEK_MS, pickItemOf, type BondingStats, type OutcomeResult } from "./pick-outcomes.ts";
import { cleanTopic, NOT_WITHDRAWN, type PickSource } from "./picks.ts";

/**
 * The Scoreboard (human researcher ticket 08, ADR 0017): the Operator's and the machine's bonded-within-24h rate over the last 7 days, each with n.
 * Plain code, no model. Both sides are scored by `bondingStats` over the same outcome rows (ticket 04), so the rule for an already-bonded or an unknown
 * coin is one rule. The comparison is fair by construction:
 *  - the Operator side is every non-withdrawn Operator Pick on a compared topic (ticket 11), including coins no brief ever listed: the machine has to beat the
 *    Operator as he really is. The machine still chooses only from a brief's coin list. A Pick belongs to a topic when its topic, cleaned and compared without
 *    regard to letter case, equals the topic of a research request; a Pick with no topic belongs to none;
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
  /** The compared Picks: same topics, every non-withdrawn Operator Pick on them. */
  operator: BondingStats;
  machine: BondingStats;
  /** The topics compared (as first typed), sorted. */
  topics: string[];
  /** Operator Picks left out of the comparison (no topic, a topic of no research request, or a topic the machine made no pick on), shown on their own. */
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
 * The Scoreboard over the Picks of the window. `requestTopics` is the set of topic keys (`scoreTopicKey`) of research requests: an Operator Pick belongs to a
 * topic only when its key is in it, and a Pick with no topic belongs to none. Pure.
 */
export function buildScoreboard(items: readonly ScoreItem[], requestTopics: ReadonlySet<string>): Scoreboard {
  const operatorEligible = items.filter((i) => i.source === "operator" && requestTopics.has(scoreTopicKey(i.topic)));
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
    .prepare("SELECT p.ca, p.source, p.topic, p.created_at, p.bonded_at_pick, o.result AS o_result FROM picks p LEFT JOIN pick_outcomes o ON o.pick_id = p.id WHERE p.created_at > ? AND " + NOT_WITHDRAWN)
    .all(new Date(nowMs - SCOREBOARD_WINDOW_MS).toISOString()) as Row[];
  const items: ScoreItem[] = rows.map((r) => {
    const { over, result } = pickItemOf(r, nowMs);
    return { source: r.source as PickSource, ca: r.ca as string, topic: r.topic as string, over, result };
  });
  const requests = db.prepare("SELECT topic FROM research_requests").all() as Row[];
  const requestTopics = new Set(requests.map((r) => scoreTopicKey(String(r.topic))).filter((k) => k !== ""));
  return buildScoreboard(items, requestTopics);
}
