// The Operator's Verdict form on /narratives/<id> and the pill on /narratives (War Room ticket 19): what each button, tag and history row says,
// the counter, and the one POST. The lists below repeat the server's (`VERDICTS`, `VERDICT_TAGS`, `RUBRIC_KEYS`, `MAX_VERDICT_NOTE_CHARS` in
// core; the app does not import core, and a test holds the two equal). The server is the check. Everything shown is text: a note is cut by
// `clampText`, nothing here builds HTML or a link.
import { failureReason } from "./angle.ts";
import { ageText, clampText } from "./meta.ts";

export const VERDICT_NOTE_MAX = 500;
const NOTE_SHOWN_CHARS = 300;

export type VerdictValue = "good" | "bad";
export const VERDICT_LABELS: Record<VerdictValue, string> = { good: "Good", bad: "Bad" };

export const TAG_OPTIONS = [
  { value: "wrong-cluster", label: "Wrong cluster", hint: "The Signals are not one story" },
  { value: "duplicate", label: "Duplicate", hint: "Of another Narrative" },
  { value: "score-too-high", label: "Score too high", hint: "" },
  { value: "score-too-low", label: "Score too low", hint: "" },
] as const;
export const SCORE_TAG_VALUES: readonly string[] = ["score-too-high", "score-too-low"];
export const DIMENSION_OPTIONS = ["momentum", "novelty", "buildability", "hook", "legitimacy"] as const;

/** The list filter on /narratives: `none` is "no verdict yet". */
export const VERDICT_FILTER = [
  { value: "", label: "Any" },
  { value: "good", label: "Good" },
  { value: "bad", label: "Bad" },
  { value: "none", label: "None" },
];

/** One verdict as GET /api/narratives/:id sends it (the server's `NarrativeVerdict`). */
export interface VerdictPayload {
  id: number;
  verdict: string;
  tags: string[];
  dimensions: string[];
  note: string;
  scoreId: number | null;
  rubricVersion: number | null;
  createdAt: string;
}

export interface VerdictRowView {
  id: number;
  label: string;
  tone: "good" | "bad";
  tags: string[];
  dimensions: string[];
  /** The note as text, cut; "" when there is none. */
  note: string;
  when: string | null;
  /** The Rubric version it was made against ("Rubric v3"), or "not scored". */
  against: string;
}

export interface VerdictFormInput {
  history: readonly VerdictPayload[] | null | undefined;
  choice: string | null;
  tags: readonly string[];
  dimensions: readonly string[];
  draft: string;
  nowMs: number;
  busy?: boolean;
}

export interface VerdictFormView {
  /** The newest verdict (the current one), or null. */
  current: VerdictRowView | null;
  /** The ones it replaced, newest first. */
  earlier: VerdictRowView[];
  choices: Array<{ value: VerdictValue; label: string; on: boolean }>;
  tagOptions: Array<{ value: string; label: string; hint: string; on: boolean }>;
  /** The Rubric dimensions are asked only while a score tag is on. */
  showDimensions: boolean;
  dimensionOptions: Array<{ value: string; label: string; on: boolean }>;
  counter: string;
  canSubmit: boolean;
}

const tagLabel = (value: string) => TAG_OPTIONS.find((t) => t.value === value)?.label ?? clampText(value, 30);

function rowView(v: VerdictPayload, nowMs: number): VerdictRowView {
  const good = v.verdict === "good";
  return {
    id: v.id,
    label: good ? VERDICT_LABELS.good : VERDICT_LABELS.bad,
    tone: good ? "good" : "bad",
    tags: (Array.isArray(v.tags) ? v.tags : []).map(tagLabel),
    dimensions: (Array.isArray(v.dimensions) ? v.dimensions : []).map((d) => clampText(d, 30)),
    note: clampText(v.note, NOTE_SHOWN_CHARS),
    when: typeof v.createdAt === "string" ? ageText(v.createdAt, nowMs) : null,
    against: v.rubricVersion === null || v.rubricVersion === undefined ? "not scored" : `Rubric v${v.rubricVersion}`,
  };
}

/** "37 / 500", counting characters (not UTF-16 units) of the trimmed note, as the server does. */
export const verdictCounter = (draft: string): string => `${[...draft.trim()].length} / ${VERDICT_NOTE_MAX}`;

export function verdictFormView(input: VerdictFormInput): VerdictFormView {
  const rows = (Array.isArray(input.history) ? input.history : []).map((v) => rowView(v, input.nowMs));
  const showDimensions = input.tags.some((t) => SCORE_TAG_VALUES.includes(t));
  const length = [...input.draft.trim()].length;
  return {
    current: rows[0] ?? null,
    earlier: rows.slice(1),
    choices: (["good", "bad"] as const).map((value) => ({ value, label: VERDICT_LABELS[value], on: input.choice === value })),
    tagOptions: TAG_OPTIONS.map((t) => ({ value: t.value, label: t.label, hint: t.hint, on: input.tags.includes(t.value) })),
    showDimensions,
    dimensionOptions: DIMENSION_OPTIONS.map((value) => ({ value, label: value, on: input.dimensions.includes(value) })),
    counter: verdictCounter(input.draft),
    canSubmit: (input.choice === "good" || input.choice === "bad") && length <= VERDICT_NOTE_MAX && input.busy !== true,
  };
}

/** The pill on a list row: null when the Narrative has no verdict. */
export function verdictPill(verdict: unknown): { label: string; tone: "good" | "bad" } | null {
  if (verdict === "good") return { label: `Verdict: ${VERDICT_LABELS.good}`, tone: "good" };
  if (verdict === "bad") return { label: `Verdict: ${VERDICT_LABELS.bad}`, tone: "bad" };
  return null;
}

export interface VerdictBody {
  verdict: string;
  tags: string[];
  dimensions: string[];
  note: string;
}

/** What the form sends: dimensions only while a score tag is on, the note as typed (the server trims it). */
export function verdictBody(input: Pick<VerdictFormInput, "choice" | "tags" | "dimensions" | "draft">): VerdictBody {
  const showDimensions = input.tags.some((t) => SCORE_TAG_VALUES.includes(t));
  return { verdict: input.choice ?? "", tags: [...input.tags], dimensions: showDimensions ? [...input.dimensions] : [], note: input.draft };
}

export type VerdictSubmit = { ok: true } | { ok: false; message: string };

/** Sends one verdict through `post` (the page's `$fetch`) and says what happened. Never throws. */
export async function submitVerdict(post: (body: VerdictBody) => Promise<unknown>, body: VerdictBody): Promise<VerdictSubmit> {
  try {
    await post(body);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: failureReason(e) };
  }
}

/** One Proposal link under the Narrative: text only; the id makes the href. */
export interface NarrativeProposalPayload {
  id: number;
  name: string;
  ticker: string;
  kind: string;
  status: string;
}
