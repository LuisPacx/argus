// The Playbook panel on /research (human researcher ticket 09): what GET /api/playbook sends, turned into the text the page shows, and the one POST the
// "Rebuild playbook" button makes. The lessons were written by a model from the Operator's Picks (whose reasons are Operator-typed), so every line is cut
// and shown as text. The refusal reasons come from the server; the page only shows them and never decides.
import { clampText } from "./meta.ts";
import { failureMessage } from "./research.ts";

const LESSON_CLAMP = 240;
const DETAIL_CLAMP = 300;
const SHOWN_VERSIONS = 5;
const SHOWN_REQUESTS = 3;

/** core's `PlaybookState` as GET /api/playbook sends it (a field renamed there is a type error in the server test). */
export interface PlaybookPayload {
  minPicks: number;
  finishedPicks: number;
  ratedIdeas: number;
  picksNote: string | null;
  ideasNote: string | null;
  open: boolean;
  refusal: string | null;
  versions: { id: string; text: string; ideasText: string; createdAt: string; pickCount: number; ideaCount: number; settleCutoff: string }[];
  requests: { id: number; status: string; detail: string; createdAt: string; doneAt: string | null; costUsd: number; costEstimated: boolean }[];
  learning: { version: string | null; made: number; rated: number; good: number }[];
}

export interface PlaybookVersionLine {
  id: string;
  title: string;
  lessons: string[];
  /** The "Ideas you liked / disliked" lessons (ticket 18); empty for a version without them. */
  ideaLessons: string[];
}

/** Ratings are few and unblinded (the Operator knows which ideas had a Playbook): no comparison is worded below this many rated ideas per version. */
export const LEARNING_MIN_RATED = 10;
export const LEARNING_CAPTION = "Ratings are unblinded and few: you know which ideas were made with a Playbook. Only explicit Good or Bad counts; a dismissal is not a rating.";

export interface PlaybookView {
  /** "Latest version 3, built from 12 Picks" or "No Playbook yet". */
  headline: string;
  /** What a rebuild reads and needs: "12 of your Picks have a finished result; a rebuild needs 10." */
  picks: string;
  /** Why the button is refused right now (from the server), or null when it is not. */
  refusal: string | null;
  canRebuild: boolean;
  /** Why a section would be left out of a rebuild pressed now (server text), or null. */
  picksNote: string | null;
  ideasNote: string | null;
  versions: PlaybookVersionLine[];
  /** "Is it learning?": one line per version and the no-Playbook baseline (always last). */
  learning: string[];
  /** One comparison sentence, only when the newest version and the baseline each have 10 rated ideas; otherwise null. */
  trend: string | null;
  caption: string;
  /** The newest rebuild requests in words, with the cost of their run. */
  requests: string[];
}

const when = (iso: string): string => iso.slice(0, 16).replace("T", " ") + " UTC";
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

const learningLine = (label: string, r: PlaybookPayload["learning"][number]): string => {
  const good = r.rated > 0 ? `good ${r.good} (${Math.round((r.good / r.rated) * 100)}%)` : "good 0";
  return `${label}: ideas made with it: ${r.made}, rated ${r.rated}, ${good}, unrated ${r.made - r.rated}`;
};

export function playbookView(p: PlaybookPayload | null): PlaybookView {
  if (p === null) return { headline: "No Playbook yet", picks: "Loading…", refusal: null, canRebuild: false, picksNote: null, ideasNote: null, versions: [], learning: [], trend: null, caption: LEARNING_CAPTION, requests: [] };
  const latest = p.versions[0];
  const learning = p.learning ?? [];
  const newest = latest ? learning.find((r) => r.version === latest.id) : undefined;
  const base = learning.find((r) => r.version === null);
  const enough = newest !== undefined && base !== undefined && newest.rated >= LEARNING_MIN_RATED && base.rated >= LEARNING_MIN_RATED;
  const pct = (r: { good: number; rated: number }): number => Math.round((r.good / r.rated) * 100);
  return {
    headline: latest ? `Latest version ${clampText(latest.id, 12)}, built from ${plural(latest.pickCount, "Pick")}${latest.ideaCount > 0 ? ` and ${plural(latest.ideaCount, "rated idea")}` : ""}` : "No Playbook yet",
    caption: LEARNING_CAPTION,
    picksNote: p.picksNote === null ? null : clampText(p.picksNote, DETAIL_CLAMP),
    ideasNote: p.ideasNote === null ? null : clampText(p.ideasNote, DETAIL_CLAMP),
    learning: learning.map((r) => learningLine(r.version === null ? "No idea lessons" : `Version ${clampText(r.version, 12)}`, r)),
    trend: enough ? `Version ${clampText(newest.version ?? "", 12)}: ${pct(newest)}% of its rated ideas are Good, against ${pct(base)}% with no idea lessons. Small, unblinded numbers: a hint, not a result.` : null,
    picks: `${p.finishedPicks} of your Picks ${p.finishedPicks === 1 ? "has" : "have"} a finished bonded or not-bonded result; a rebuild needs ${p.minPicks}.`,
    refusal: p.refusal === null ? null : clampText(p.refusal, DETAIL_CLAMP),
    canRebuild: p.refusal === null && !p.open,
    versions: p.versions.slice(0, SHOWN_VERSIONS).map((v) => ({
      id: v.id,
      title: `Version ${clampText(v.id, 12)}, ${when(v.createdAt)}, ${plural(v.pickCount, "Pick")}${v.ideaCount > 0 ? `, ${plural(v.ideaCount, "rated idea")}` : ""}, all settled by ${when(v.settleCutoff)}`,
      lessons: v.text.split("\n").map((l) => clampText(l, LESSON_CLAMP)).filter((l) => l !== ""),
      ideaLessons: (v.ideasText ?? "").split("\n").map((l) => clampText(l, LESSON_CLAMP)).filter((l) => l !== ""),
    })),
    requests: p.requests.slice(0, SHOWN_REQUESTS).map((r) => `${when(r.createdAt)}: ${clampText(r.status, 12)}${r.detail !== "" ? `, ${clampText(r.detail, DETAIL_CLAMP)}` : ""}${r.costUsd > 0 ? `, ${r.costEstimated ? "about " : ""}$${r.costUsd.toFixed(2)}` : ""}`),
  };
}

/** The button: one POST /api/playbook-requests with an empty body. Never throws; a refusal's reason is the server's own text. */
export async function submitRebuild(post: (body: Record<string, never>) => Promise<{ id: number; status: string }>): Promise<{ ok: true; note: string } | { ok: false; message: string }> {
  try {
    await post({});
    return { ok: true, note: "Sent. The worker rebuilds the Playbook next: one model run, a few minutes at most." };
  } catch (e) {
    return { ok: false, message: failureMessage(e) };
  }
}
