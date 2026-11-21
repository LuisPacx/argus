import type { DatabaseSync } from "node:sqlite";
import { normalizeEvidenceLinks } from "../evidence-links.ts";
import { cleanLine } from "./ideas.ts";

/**
 * The Operator's angle on a Meta (meta redesign ticket 11): a third source of meme ideas beside the Meta-triggered pass and the news stories.
 * The Operator types an angle on `/meta`; the War Room writes one `meme_angle_requests` row (and nothing else); the worker runs the same
 * `meme-ideas` path with the angle in the prompt and files the trio as normal `meme` Proposals. The text is Operator-written but carries
 * links and quotes, so it is untrusted for the prompt (a fenced block) and for the page (text only; a link only through `safeHttpUrl`).
 */

/** The longest angle, in characters after cleaning (the form's `maxlength`). */
export const ANGLE_MAX_CHARS = 600;
/**
 * The daily allowance of angle requests in any rolling 24 h (Decision 3, raised from 5 to 10 by ticket 16): the default and the most
 * `ARGUS_MEME_ANGLE_MAX_PER_DAY` may say. A request that ended refused, failed or capped does not spend it (ticket 16); one that is waiting,
 * running or done does. Every request, whatever became of it, counts toward the hard cap `angleAttemptCap`.
 */
export const DEFAULT_MEME_ANGLE_PER_DAY = 10;
/** The hard ceiling in code: `requestMemeAngle` never allows more than this in 24 h, whatever it is given. */
export const MAX_MEME_ANGLE_PER_DAY = 10;
/** The hard cap on all angle attempts in 24 h, refused ones and retries included, is this many times the allowance (ticket 16), so spend stays bounded when refusals do not spend the allowance. */
export const ANGLE_ATTEMPT_CAP_FACTOR = 3;
export const angleAttemptCap = (allowance: number): number => ANGLE_ATTEMPT_CAP_FACTOR * allowance;
/** The statuses that spend the allowance: a request the worker has not ended yet, or ended by filing Proposals. */
export const ANGLE_SPENDING_STATUSES: readonly AngleStatus[] = ["pending", "running", "done"];
/** Rows `GET /api/meme-angle` returns. */
export const ANGLE_LIST_LIMIT = 20;
/** The same cleaned angle for the same Meta is refused for this long (Decision 6). */
export const ANGLE_DUPLICATE_MS = 24 * 3_600_000;
export const ANGLE_WINDOW_MS = 24 * 3_600_000;

/** What became of a request. `pending`: waiting for the worker. `running`: the worker took it. `done`: three Proposals were filed. `refused`: the answer did not fit or the Meta is gone. `failed`: the run failed. `capped`: a cap was reached, no run was started. */
export type AngleStatus = "pending" | "running" | "done" | "refused" | "failed" | "capped";

export interface AngleRequest {
  id: number;
  /** The Meta (or Watching subject) key, and its label as it was at the request. */
  metaKey: string;
  metaLabel: string;
  /** The cleaned angle, with the link replaced by its host: what the prompt is given. Operator-typed: untrusted. */
  angle: string;
  /** The first http(s) link of the text when it is a plain one (no credentials), else null. Shown as a link only after `safeHttpUrl`. */
  sourceUrl: string | null;
  /** True when the text had a link that was not a plain http(s) address and so was dropped. */
  urlDropped: boolean;
  status: AngleStatus;
  /** Code-written reason of a refusal, a cap or a failure; `3 ideas` when done. */
  detail: string;
  createdAt: string;
  doneAt: string | null;
  /** The Proposals the run filed, in slot order. */
  proposalIds: number[];
  /**
   * Set when the request is a Make ideas on a Research brief (human researcher ticket 06) and not on a Meta: the id of the research request whose
   * brief is the subject. `metaKey` is then `topic:<id>` and `metaLabel` the topic. Null on a Meta's request, so older rows read as before.
   */
  researchRequestId: number | null;
}

/** The `meta_key` of a topic's ideas (a Proposal made from a Research brief): `topic:<research request id>`. */
export const TOPIC_KEY_PREFIX = "topic:";
export const topicKey = (researchRequestId: number): string => `${TOPIC_KEY_PREFIX}${researchRequestId}`;

/** The angle text stored for a Make ideas with no angle typed (Meta button, ticket 02): the card words its source by this text. */
export const MAKE_IDEAS_ANGLE_TEXT = "Pressed Make ideas (no angle typed)";

/** What `GET /api/meme-angle` returns per row: the status and the ids, never the angle text or the link. */
export interface AngleRequestRow {
  id: number;
  metaKey: string;
  status: AngleStatus;
  detail: string;
  createdAt: string;
  doneAt: string | null;
  proposalIds: number[];
  urlDropped: boolean;
}

/** Stored with each Proposal an angle trio made (`proposals.operator_angle`); null on every other Proposal. */
export interface OperatorAngle {
  requestId: number;
  angle: string;
  sourceUrl: string | null;
  urlDropped: boolean;
  /**
   * The source marker readers branch on (human researcher ticket 06): `"topic"` on an idea made from a Research brief (`angle` is then the topic and
   * `researchRequestId` the brief's request); absent on every idea made from a Meta, so older Proposals read as before.
   */
  source?: "topic";
  researchRequestId?: number;
}

export type AngleParse = { ok: true; angle: string; sourceUrl: string | null; urlDropped: boolean } | { ok: false; problem: string };

const LINK_RE = /https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}]+$/;

/**
 * The form's text as the request stores it: flattened to one line (control, invisible and line characters become spaces), at most
 * `ANGLE_MAX_CHARS` after that, and the first http(s) link split out by code, never by the model. A link that is a plain address becomes
 * `sourceUrl` (the same test as the pages' `safeHttpUrl`: absolute http or https, no credentials); one that is not is dropped and
 * `urlDropped` says so. Either way the link in the text is replaced by its host, so the model is not asked to fetch it.
 */
export function parseAngle(raw: unknown): AngleParse {
  if (typeof raw !== "string") return { ok: false, problem: "the angle must be text" };
  const flat = cleanLine(raw, ANGLE_MAX_CHARS + 1);
  if (flat === "") return { ok: false, problem: "the angle is empty" };
  if ([...flat].length > ANGLE_MAX_CHARS) return { ok: false, problem: `the angle is over ${ANGLE_MAX_CHARS} characters` };
  const found = LINK_RE.exec(flat);
  if (!found) return { ok: true, angle: flat, sourceUrl: null, urlDropped: false };
  const link = found[0].replace(TRAILING_PUNCTUATION_RE, "");
  let sourceUrl: string | null = null;
  let host = "";
  try {
    host = new URL(link).host;
    sourceUrl = normalizeEvidenceLinks([link])[0] ?? null;
  } catch {
    // not a plain address: no link is kept
  }
  const shown = host !== "" ? host : "link removed";
  return { ok: true, angle: `${flat.slice(0, found.index)}${shown}${flat.slice(found.index + link.length)}`, sourceUrl, urlDropped: sourceUrl === null };
}

/**
 * ARGUS_MEME_ANGLE_MAX_PER_DAY: a whole number from 1 to the default of 10 (it can only lower the cap, Decision 3); unset or empty is the
 * default; anything else is an error and never a fallback, as for the other ARGUS_* caps.
 */
export function memeAngleConfigFromEnv(env: Record<string, string | undefined>): { maxPerDay: number } {
  const raw = env.ARGUS_MEME_ANGLE_MAX_PER_DAY?.trim() ?? "";
  if (raw === "") return { maxPerDay: DEFAULT_MEME_ANGLE_PER_DAY };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > DEFAULT_MEME_ANGLE_PER_DAY) throw new Error(`ARGUS_MEME_ANGLE_MAX_PER_DAY must be a whole number from 1 to ${DEFAULT_MEME_ANGLE_PER_DAY} (it can only lower the cap), got "${env.ARGUS_MEME_ANGLE_MAX_PER_DAY}"`);
  return { maxPerDay: v };
}

/** Additive and idempotent: one table; the Proposal column is added beside the other additive ones in `migrate`. */
export function migrateAngles(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meme_angle_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meta_key TEXT NOT NULL,
    meta_label TEXT NOT NULL DEFAULT '',
    angle TEXT NOT NULL,
    source_url TEXT,
    url_dropped INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    done_at TEXT,
    proposal_ids TEXT NOT NULL DEFAULT '[]'
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS meme_angle_requests_at ON meme_angle_requests (created_at)");
}

type Row = Record<string, string | number | null>;

function ids(text: unknown): number[] {
  try {
    const v = JSON.parse(String(text)) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x)) : [];
  } catch {
    return [];
  }
}

export function toAngleRequest(r: Row): AngleRequest {
  return {
    id: r.id as number,
    metaKey: r.meta_key as string,
    metaLabel: r.meta_label as string,
    angle: r.angle as string,
    sourceUrl: (r.source_url as string | null) ?? null,
    urlDropped: r.url_dropped === 1,
    status: r.status as AngleStatus,
    detail: r.detail as string,
    createdAt: r.created_at as string,
    doneAt: (r.done_at as string | null) ?? null,
    proposalIds: ids(r.proposal_ids),
    researchRequestId: Number.isSafeInteger(r.research_request_id) ? (r.research_request_id as number) : null,
  };
}

export function toAngleRow(a: AngleRequest): AngleRequestRow {
  return { id: a.id, metaKey: a.metaKey, status: a.status, detail: a.detail, createdAt: a.createdAt, doneAt: a.doneAt, proposalIds: a.proposalIds, urlDropped: a.urlDropped };
}

/** The key two angles are compared by: the cleaned text, lower-cased. */
export const angleKey = (angle: string): string => angle.toLowerCase();
