import type { DatabaseSync } from "node:sqlite";
import { MAX_VERDICT_NOTE_CHARS, VERDICTS, type Verdict } from "./narrative-verdict.ts";

/**
 * The Operator's Idea verdict (War Room ticket 21, GLOSSARY: Idea verdict): Good or Bad on a meme-kind Proposal's idea, one click, with optional
 * reason tags and a note. Only an explicit Good or Bad counts: a dismissal is never a signal. Append-only (the newest row per Proposal is the
 * current one, the rest are history), with the Proposal's kind and Playbook version read from the store and a clamped snapshot of the idea
 * (name, ticker, angle) as it was at verdict time. The Playbook rebuild reads the current ones (human researcher ticket 18, `loadPlaybookIdeas`); no other prompt does yet.
 */

/** What the Operator may say about an idea. The good ones come first, then the bad ones. */
export const IDEA_VERDICT_TAGS = ["good-name", "funny", "great-hook", "fresh-angle", "timely", "name-taken", "too-generic", "wrong-angle", "boring", "risky"] as const;
export type IdeaVerdictTag = (typeof IDEA_VERDICT_TAGS)[number];

/** The most characters of the note: the same limit as a Narrative verdict's. */
export const MAX_IDEA_NOTE_CHARS = MAX_VERDICT_NOTE_CHARS;

/** How much of the idea is kept in a verdict row (code points). The ideas are short; the clamp only bounds a hostile one. */
export const IDEA_SNAPSHOT_LIMITS = { name: 80, ticker: 20, angle: 300 } as const;

/** The body keys the route reads. `playbookVersion` and `kind` are tolerated and ignored: the store supplies both. */
const BODY_KEYS = ["verdict", "tags", "note"];
const IGNORED_KEYS = ["playbookVersion", "kind"];

export interface IdeaSnapshot {
  name: string;
  ticker: string;
  angle: string;
}

export interface ProposalVerdict {
  id: number;
  proposalId: number;
  verdict: Verdict;
  tags: IdeaVerdictTag[];
  note: string;
  /** The Proposal's kind when the verdict was made (always `meme` today; kept so a later kind is not guessed). */
  kind: string;
  /** The Playbook version the Proposal's prompt carried, copied from the Proposal; null when it had none. */
  playbookVersion: string | null;
  /** The idea as it was when the verdict was made. */
  idea: IdeaSnapshot;
  createdAt: string;
}

export interface NewProposalVerdict {
  proposalId: number;
  verdict: Verdict;
  tags: readonly IdeaVerdictTag[];
  note: string;
}

export type IdeaVerdictBody = Pick<NewProposalVerdict, "verdict" | "tags" | "note">;
export type IdeaVerdictParse = { ok: true; value: IdeaVerdictBody } | { ok: false; message: string };

const clamp = (text: unknown, max: number): string => {
  const chars = [...(typeof text === "string" ? text : "")];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
};

/** The clamped idea as stored (JSON text): name, ticker and angle, each cut to `IDEA_SNAPSHOT_LIMITS`. */
export function ideaSnapshot(idea: { name: string; ticker: string; angle: string }): string {
  return JSON.stringify({ name: clamp(idea.name, IDEA_SNAPSHOT_LIMITS.name), ticker: clamp(idea.ticker, IDEA_SNAPSHOT_LIMITS.ticker), angle: clamp(idea.angle, IDEA_SNAPSHOT_LIMITS.angle) });
}

/** What the War Room's POST sends: a body of `{ verdict, tags?, note? }`, checked here so no caller skips a check. Never throws. */
export function parseIdeaVerdictBody(body: unknown): IdeaVerdictParse {
  const fail = (message: string): IdeaVerdictParse => ({ ok: false, message });
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("The body must be a JSON object with a verdict");
  if (Object.keys(body).some((k) => !BODY_KEYS.includes(k) && !IGNORED_KEYS.includes(k))) return fail(`The body has keys other than ${BODY_KEYS.join(", ")}`);
  const { verdict: rawVerdict, tags: rawTags, note: rawNote } = body as Record<string, unknown>;
  const verdict = VERDICTS.find((v) => v === rawVerdict);
  if (verdict === undefined) return fail("Unknown verdict");
  const tags: IdeaVerdictTag[] = [];
  if (rawTags !== undefined) {
    if (!Array.isArray(rawTags)) return fail("tags must be a list");
    for (const item of rawTags) {
      const known = IDEA_VERDICT_TAGS.find((t) => t === item);
      if (known === undefined) return fail("Unknown tag");
      if (!tags.includes(known)) tags.push(known);
    }
  }
  if (rawNote !== undefined && typeof rawNote !== "string") return fail("The note must be text");
  const note = (rawNote ?? "").trim();
  if ([...note].length > MAX_IDEA_NOTE_CHARS) return fail(`The note is over ${MAX_IDEA_NOTE_CHARS} characters`);
  return { ok: true, value: { verdict, tags, note } };
}

/** Additive and idempotent: one table and its index. */
export function migrateProposalVerdicts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS proposal_verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    playbook_version TEXT,
    idea TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS proposal_verdicts_proposal ON proposal_verdicts (proposal_id, id)");
}

type Row = Record<string, string | number | null>;

function readTags(text: unknown): IdeaVerdictTag[] {
  try {
    const v = JSON.parse(String(text)) as unknown;
    return Array.isArray(v) ? v.filter((x): x is IdeaVerdictTag => IDEA_VERDICT_TAGS.includes(x as IdeaVerdictTag)) : [];
  } catch {
    return [];
  }
}

function readIdea(text: unknown): IdeaSnapshot {
  try {
    const v = JSON.parse(String(text)) as Partial<IdeaSnapshot> | null;
    return { name: clamp(v?.name, IDEA_SNAPSHOT_LIMITS.name), ticker: clamp(v?.ticker, IDEA_SNAPSHOT_LIMITS.ticker), angle: clamp(v?.angle, IDEA_SNAPSHOT_LIMITS.angle) };
  } catch {
    return { name: "", ticker: "", angle: "" };
  }
}

export function toProposalVerdict(r: Row): ProposalVerdict {
  return {
    id: r.id as number,
    proposalId: r.proposal_id as number,
    verdict: r.verdict as Verdict,
    tags: readTags(r.tags),
    note: r.note as string,
    kind: r.kind as string,
    playbookVersion: (r.playbook_version as string | null) ?? null,
    idea: readIdea(r.idea),
    createdAt: r.created_at as string,
  };
}
