// The Scoreboard on /research (human researcher ticket 08): what GET /api/scoreboard sends, turned into the text the page shows. The rates, the counts and
// the verdict are computed by core; this only words them. A rate always shows its n, an empty side is never 0%, and the verdict threshold (20 finished Picks
// on each side) is part of the text so the Operator can see why no winner is named. The topics are Operator-typed and untrusted: cut to a line, shown as text.
import { clampText } from "./meta.ts";

/** Mirror of core's `SCOREBOARD_MIN_PICKS`, only for the empty state before the first answer; the real number always comes in the payload. */
const FALLBACK_MIN_PICKS = 20;
const TOPIC_CLAMP = 60;
const COUNTED = "Counted: every Operator Pick on those topics (withdrawn ones left out), against the machine's picks from the brief lists.";
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

interface StatsPayload {
  bonded: number;
  finished: number;
  rate: number | null;
  alreadyBonded: number;
  unknown: number;
  pending: number;
}
/** core's `Scoreboard` as GET /api/scoreboard sends it (a field renamed there is a type error in the server test). */
export interface ScoreboardPayload {
  windowDays: number;
  minPicks: number;
  operator: StatsPayload;
  machine: StatsPayload;
  topics: string[];
  operatorOutside: StatsPayload;
  machineOutside: StatsPayload;
  verdict: { kind: "not-enough" | "machine" | "operator" | "level"; text: string };
}

export interface ScoreSideView {
  label: string;
  /** "40%" or "no finished Picks yet": never "0%" for an empty side. */
  rate: string;
  /** "n=20 (8 bonded)". */
  n: string;
  /** What is left out of this side's rate: pending, already bonded, unknown. */
  leftOut: string;
}
export interface ScoreboardView {
  title: string;
  window: string;
  rule: string;
  /** The one line saying what is counted. */
  counted: string;
  compared: ScoreSideView[];
  topics: string;
  outside: ScoreSideView[];
  verdict: { text: string; kind: ScoreboardPayload["verdict"]["kind"]; decided: boolean };
}

const n = (x: number): number => (finite(x) ? Math.max(0, Math.trunc(x)) : 0);

function sideView(label: string, s: StatsPayload | undefined): ScoreSideView {
  const finished = n(s?.finished ?? 0);
  const bonded = n(s?.bonded ?? 0);
  const parts: string[] = [];
  if (n(s?.pending ?? 0) > 0) parts.push(`${n(s?.pending ?? 0)} not finished yet`);
  if (n(s?.alreadyBonded ?? 0) > 0) parts.push(`${n(s?.alreadyBonded ?? 0)} already bonded`);
  if (n(s?.unknown ?? 0) > 0) parts.push(`${n(s?.unknown ?? 0)} unknown`);
  return {
    label,
    rate: finished === 0 || !finite(s?.rate) ? "no finished Picks yet" : `${Math.round((s?.rate ?? 0) * 100)}%`,
    n: `n=${finished}${finished > 0 ? ` (${bonded} bonded)` : ""}`,
    leftOut: parts.length > 0 ? `Left out of the rate: ${parts.join(", ")}.` : "",
  };
}

/** The Scoreboard as the page shows it; `null` (not loaded yet) gives the empty state with the rule still printed. */
export function scoreboardView(p: ScoreboardPayload | null | undefined): ScoreboardView {
  const min = p && finite(p.minPicks) && p.minPicks > 0 ? Math.trunc(p.minPicks) : FALLBACK_MIN_PICKS;
  const days = p && finite(p.windowDays) ? Math.trunc(p.windowDays) : 7;
  const kind = p?.verdict?.kind ?? "not-enough";
  // The page never draws a winner by itself: it shows core's verdict text, and only when the counts it was sent really reach the threshold.
  const decided = p !== null && p !== undefined && kind !== "not-enough" && n(p.operator.finished) >= min && n(p.machine.finished) >= min;
  const topics = (p?.topics ?? []).map((t) => clampText(t, TOPIC_CLAMP)).filter((t) => t !== "");
  return {
    title: "Scoreboard: Operator against machine",
    window: `Bonded within 24 hours of the Pick, last ${days} days.`,
    rule: `No verdict is drawn until each side has ${min} finished Picks.`,
    compared: [sideView("Operator", p?.operator), sideView("Machine", p?.machine)],
    counted: COUNTED,
    topics: topics.length > 0 ? `Topics compared (both sides picked): ${topics.join(", ")}` : "No topic has Picks from both sides yet.",
    outside: [sideView("Operator, no topic or a topic the machine did not pick on", p?.operatorOutside), sideView("Machine, topics the Operator did not pick on", p?.machineOutside)],
    verdict: decided && p ? { text: p.verdict.text, kind, decided: true } : { text: `Not enough Picks yet: a verdict needs ${min} finished Picks on each side.`, kind: "not-enough", decided: false },
  };
}
