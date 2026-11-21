import type { DatabaseSync } from "node:sqlite";
import { toPick, type PickSnapshot, type ResearchPick } from "./picks.ts";

/**
 * Shadow picks (human researcher ticket 08, ADR 0017): the coin or coins the researcher agent chooses from a brief's own coin list, on research the
 * Operator triggered and never on its own schedule. A Shadow pick is a row of `picks` with `source = 'shadow'`, so the outcome job of ticket 04 tracks it
 * with the very same code as an Operator Pick. Two things are stored beside it, in `shadow_picks`: the request it came from and the Playbook version it
 * used (none when no eligible version existed). Both tables refuse an update or a delete in the database itself, so a Shadow pick keeps the time it was made.
 *
 * Fairness rests on three rules kept in code:
 *  - the machine sees only the brief's candidates (the answer is refused when a pick is not one of its own `coins`);
 *  - the prompt holds nothing of the Operator's Picks, reasons or counts; the one Operator-derived input is a Playbook version that passes
 *    `eligiblePlaybook`: built only from Picks whose 24 hour outcome settled before the research request started;
 *  - the Scoreboard (`scoreboard.ts`) scores both sides with the same code and compares like with like.
 */

/** The most Shadow picks one research run makes (the same limit the answer is checked against: `BRIEF_LIMITS.picks`). */
export const SHADOW_PICKS_MAX = 2;

/**
 * One version of the Playbook (ticket 09), as the leak guard needs to see it. Ticket 09 implements `PlaybookSource` over its own table; each version
 * stores the ids of the Picks it was built from and the settle-time cutoff of those Picks (the latest settle time among them, ISO).
 */
export interface PlaybookVersion {
  /** The id recorded on a Shadow pick; whatever ticket 09 calls a version (its row id, as text). */
  id: string;
  text: string;
  pickIds: readonly number[];
  settleCutoff: string;
}

/** Where the Shadow pick reads Playbook versions from. Ticket 09 provides it; until then the worker passes none and every Shadow pick records "no version". */
export interface PlaybookSource {
  /** Every version, newest first. */
  versions(): PlaybookVersion[];
}

/**
 * The leak guard. The newest version whose Picks all settled before the research request started, or null. A version is eligible only when its
 * cutoff and the settle time of every Pick it was built from (`settledAt`, from the outcome rows: when the Pick's decision and marks were complete) are
 * strictly before `requestStart`. A Pick with no settle time yet (still open) or an unreadable time makes the version ineligible, so the Operator's
 * current and recent Picks cannot reach a Shadow pick through the Playbook. The check reads the outcome rows itself and does not trust the version's own cutoff.
 */
export function eligiblePlaybook(source: PlaybookSource | undefined, settledAt: (pickIds: readonly number[]) => Map<number, string | null>, requestStart: Date): PlaybookVersion | null {
  if (source === undefined) return null;
  const start = requestStart.getTime();
  if (!Number.isFinite(start)) return null;
  const before = (iso: string | null | undefined): boolean => {
    const t = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isFinite(t) && t < start;
  };
  for (const v of source.versions()) {
    if (v.text.trim() === "" || !before(v.settleCutoff)) continue;
    const settled = settledAt(v.pickIds);
    if (v.pickIds.every((id) => before(settled.get(id)))) return v;
  }
  return null;
}

/** What `saveResearchBrief` records for each Shadow pick, taken from DexScreener by code at the moment the pick is made. */
export interface ShadowPickInput {
  snapshot: PickSnapshot;
  reason: string;
  topic: string;
  /** The Playbook version the run used, or null (none eligible). */
  playbookVersion: string | null;
}

export interface ShadowPick extends ResearchPick {
  requestId: number;
  playbookVersion: string | null;
}

/** Additive and idempotent. The Shadow record is write-once (`migratePicks` makes the Pick itself unchangeable and unremovable). */
export function migrateShadow(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shadow_picks (
    pick_id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL,
    playbook_version TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS shadow_picks_request ON shadow_picks (request_id)");
  db.exec(`CREATE TRIGGER IF NOT EXISTS shadow_picks_no_update BEFORE UPDATE ON shadow_picks
    BEGIN SELECT RAISE(ABORT, 'a Shadow pick is never changed'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS shadow_picks_no_delete BEFORE DELETE ON shadow_picks
    BEGIN SELECT RAISE(ABORT, 'a Shadow pick is never removed'); END`);
}

type Row = Record<string, string | number | null>;

/** The Shadow picks, newest first, with their request and Playbook version. READ ONLY. */
export function loadShadowPicks(db: DatabaseSync, limit: number): ShadowPick[] {
  const rows = db.prepare("SELECT p.*, s.request_id AS s_request_id, s.playbook_version AS s_playbook FROM picks p JOIN shadow_picks s ON s.pick_id = p.id WHERE p.source = 'shadow' ORDER BY p.id DESC LIMIT ?").all(limit) as Row[];
  return rows.map((r) => ({ ...toPick(r), requestId: r.s_request_id as number, playbookVersion: (r.s_playbook as string | null) ?? null }));
}

/** When each of these Picks' outcomes settled (`pick_outcomes.finished_at`: the result is decided and every mark is sampled or missed), or null while it is still open. READ ONLY. */
export function pickSettledAt(db: DatabaseSync, ids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT pick_id, finished_at FROM pick_outcomes WHERE pick_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Row[];
    for (const id of chunk) out.set(id, null);
    for (const r of rows) out.set(r.pick_id as number, (r.finished_at as string | null) ?? null);
  }
  return out;
}
