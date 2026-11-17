import type { DatabaseSync } from "node:sqlite";
import { RUBRIC_KEYS, type RubricKey } from "./rubric.ts";

/**
 * The Operator's Verdict on a Narrative (War Room ticket 19, GLOSSARY: Verdict): good or bad, optional reason tags, for the two score tags
 * the Rubric dimensions he thinks were off, and a short note. Kept as history (append-only, the newest row is the current one) with the Score
 * and Rubric version that were the Narrative's latest when it was made, so it can be compared with the judge later. Nothing reads it back
 * into the judge, the prompts or the Rubric.
 */
export const VERDICTS = ["good", "bad"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** `wrong-cluster`: the Signals are not one story. `duplicate`: of another Narrative. The last two say the Score was off. */
export const VERDICT_TAGS = ["wrong-cluster", "duplicate", "score-too-high", "score-too-low"] as const;
export type VerdictTag = (typeof VERDICT_TAGS)[number];

/** The tags that make the Operator pick the Rubric dimensions he disagrees on. */
export const SCORE_TAGS: readonly VerdictTag[] = ["score-too-high", "score-too-low"];

/** The most characters of the note, like `MAX_REVISE_INSTRUCTION_CHARS` for a revise instruction. */
export const MAX_VERDICT_NOTE_CHARS = 500;

export interface NarrativeVerdict {
  id: number;
  narrativeId: number;
  verdict: Verdict;
  tags: VerdictTag[];
  dimensions: RubricKey[];
  note: string;
  /** The Narrative's latest Score when the verdict was made; null when it had none (a launchpad Narrative is never judged). */
  scoreId: number | null;
  rubricVersion: number | null;
  createdAt: string;
}

export interface NewNarrativeVerdict {
  narrativeId: number;
  verdict: Verdict;
  tags: readonly VerdictTag[];
  dimensions: readonly RubricKey[];
  note: string;
}

/** A Score as the export shows it. */
export interface VerdictScore {
  id: number;
  rubricVersion: number;
  scores: Record<string, number>;
  total: number;
  rationale: string;
}

/** One row of GET /api/narratives/verdicts. */
export interface VerdictExportRow {
  id: number;
  narrativeId: number;
  title: string;
  verdict: Verdict;
  tags: VerdictTag[];
  dimensions: RubricKey[];
  note: string;
  createdAt: string;
  /** The Score the verdict was made against; null when the Narrative had none then. */
  score: VerdictScore | null;
  /** The Narrative's latest Score now; null when it has none. */
  latestScore: VerdictScore | null;
  /** True when the latest Score now is not the one the verdict was made against. */
  scoreChanged: boolean;
}

/** Additive and idempotent: one table and its index. */
export function migrateVerdicts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS narrative_verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    narrative_id INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    dimensions TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    score_id INTEGER,
    rubric_version INTEGER,
    created_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS narrative_verdicts_narrative ON narrative_verdicts (narrative_id, id)");
}

type Row = Record<string, string | number | null>;

function list<T extends string>(text: unknown, allowed: readonly T[]): T[] {
  try {
    const v = JSON.parse(String(text)) as unknown;
    return Array.isArray(v) ? v.filter((x): x is T => allowed.includes(x as T)) : [];
  } catch {
    return [];
  }
}

export function toNarrativeVerdict(r: Row): NarrativeVerdict {
  return {
    id: r.id as number,
    narrativeId: r.narrative_id as number,
    verdict: r.verdict as Verdict,
    tags: list(r.tags, VERDICT_TAGS),
    dimensions: list(r.dimensions, RUBRIC_KEYS),
    note: r.note as string,
    scoreId: r.score_id as number | null,
    rubricVersion: r.rubric_version as number | null,
    createdAt: r.created_at as string,
  };
}
