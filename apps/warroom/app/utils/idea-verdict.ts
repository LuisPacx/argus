// The Operator's Idea verdict on a meme Proposal (War Room ticket 21): the Good and Bad buttons, the "add why" tags and note, and the bodies they
// post to POST /api/proposals/<id>/verdict. The tag list repeats the server's (`IDEA_VERDICT_TAGS`, `MAX_IDEA_NOTE_CHARS` in core; the app does
// not import core, and a test holds the two equal). The server is the check. Everything shown is text: a note is cut by `clampText`, nothing here
// builds HTML or a link. The pure helpers (labels, counter, pill, submit) are the Narrative verdict's, from ./verdict.ts.
import { ageText, clampText } from "./meta.ts";
import { VERDICT_LABELS, VERDICT_NOTE_MAX, verdictCounter, type VerdictValue } from "./verdict.ts";

export const IDEA_NOTE_MAX = VERDICT_NOTE_MAX;
const NOTE_SHOWN_CHARS = 300;

/** What worked, then what did not. The values are the server's allowlist, in its order. */
export const IDEA_TAG_OPTIONS = [
  { value: "good-name", label: "Good name", side: "worked" },
  { value: "funny", label: "Funny", side: "worked" },
  { value: "great-hook", label: "Great hook", side: "worked" },
  { value: "fresh-angle", label: "Fresh angle", side: "worked" },
  { value: "timely", label: "Timely", side: "worked" },
  { value: "name-taken", label: "Name taken", side: "did not" },
  { value: "too-generic", label: "Too generic", side: "did not" },
  { value: "wrong-angle", label: "Wrong angle", side: "did not" },
  { value: "boring", label: "Boring", side: "did not" },
  { value: "risky", label: "Risky", side: "did not" },
] as const;

/** One Idea verdict as GET /api/proposals/:id sends it (the server's `ProposalVerdict`). */
export interface IdeaVerdictPayload {
  id: number;
  verdict: string;
  tags: string[];
  note: string;
  playbookVersion?: string | null;
  createdAt: string;
}

export interface IdeaVerdictRowView {
  id: number;
  label: string;
  tone: "good" | "bad";
  tags: string[];
  /** The note as text, cut; "" when there is none. */
  note: string;
  when: string | null;
}

export interface IdeaVerdictInput {
  history: readonly IdeaVerdictPayload[] | null | undefined;
  tags: readonly string[];
  draft: string;
  nowMs: number;
  busy?: boolean;
}

export interface IdeaVerdictView {
  /** The newest verdict (the current one), or null. */
  current: IdeaVerdictRowView | null;
  /** The ones it replaced, newest first. */
  earlier: IdeaVerdictRowView[];
  /** The two one-click buttons; `on` is the current verdict, and a click on it is not sent again. */
  choices: Array<{ value: VerdictValue; label: string; on: boolean }>;
  tagOptions: Array<{ value: string; label: string; side: string; on: boolean }>;
  counter: string;
  /** "Add why" posts a superseding row for the current verdict, so it needs one. */
  canSaveWhy: boolean;
}

const tagLabel = (value: string) => IDEA_TAG_OPTIONS.find((t) => t.value === value)?.label ?? clampText(value, 30);

function rowView(v: IdeaVerdictPayload, nowMs: number): IdeaVerdictRowView {
  const good = v.verdict === "good";
  return {
    id: v.id,
    label: good ? VERDICT_LABELS.good : VERDICT_LABELS.bad,
    tone: good ? "good" : "bad",
    tags: (Array.isArray(v.tags) ? v.tags : []).map(tagLabel),
    note: clampText(v.note, NOTE_SHOWN_CHARS),
    when: typeof v.createdAt === "string" ? ageText(v.createdAt, nowMs) : null,
  };
}

export function ideaVerdictView(input: IdeaVerdictInput): IdeaVerdictView {
  const rows = (Array.isArray(input.history) ? input.history : []).map((v) => rowView(v, input.nowMs));
  const current = rows[0] ?? null;
  const length = [...input.draft.trim()].length;
  return {
    current,
    earlier: rows.slice(1),
    choices: (["good", "bad"] as const).map((value) => ({ value, label: VERDICT_LABELS[value], on: current?.tone === value })),
    tagOptions: IDEA_TAG_OPTIONS.map((t) => ({ value: t.value, label: t.label, side: t.side, on: input.tags.includes(t.value) })),
    counter: verdictCounter(input.draft),
    canSaveWhy: current !== null && length <= IDEA_NOTE_MAX && input.busy !== true,
  };
}

export interface IdeaVerdictBody {
  verdict: string;
  tags?: string[];
  note?: string;
}

/** What a Good or Bad click sends: the verdict alone, no tags (the Operator may add why afterwards). */
export const oneClickBody = (verdict: VerdictValue): IdeaVerdictBody => ({ verdict });

/** What "add why" sends: the current verdict again, with the tags and the note as typed (the server trims the note). */
export const whyBody = (verdict: string, tags: readonly string[], draft: string): IdeaVerdictBody => ({ verdict, tags: [...tags], note: draft });
