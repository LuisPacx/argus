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
  open: boolean;
  refusal: string | null;
  versions: { id: string; text: string; createdAt: string; pickCount: number; settleCutoff: string }[];
  requests: { id: number; status: string; detail: string; createdAt: string; doneAt: string | null; costUsd: number; costEstimated: boolean }[];
}

export interface PlaybookVersionLine {
  id: string;
  title: string;
  lessons: string[];
}

export interface PlaybookView {
  /** "Latest version 3, built from 12 Picks" or "No Playbook yet". */
  headline: string;
  /** What a rebuild reads and needs: "12 of your Picks have a finished result; a rebuild needs 10." */
  picks: string;
  /** Why the button is refused right now (from the server), or null when it is not. */
  refusal: string | null;
  canRebuild: boolean;
  versions: PlaybookVersionLine[];
  /** The newest rebuild requests in words, with the cost of their run. */
  requests: string[];
}

const when = (iso: string): string => iso.slice(0, 16).replace("T", " ") + " UTC";
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

export function playbookView(p: PlaybookPayload | null): PlaybookView {
  if (p === null) return { headline: "No Playbook yet", picks: "Loading…", refusal: null, canRebuild: false, versions: [], requests: [] };
  const latest = p.versions[0];
  return {
    headline: latest ? `Latest version ${clampText(latest.id, 12)}, built from ${plural(latest.pickCount, "Pick")}` : "No Playbook yet",
    picks: `${p.finishedPicks} of your Picks ${p.finishedPicks === 1 ? "has" : "have"} a finished bonded or not-bonded result; a rebuild needs ${p.minPicks}.`,
    refusal: p.refusal === null ? null : clampText(p.refusal, DETAIL_CLAMP),
    canRebuild: p.refusal === null && !p.open,
    versions: p.versions.slice(0, SHOWN_VERSIONS).map((v) => ({
      id: v.id,
      title: `Version ${clampText(v.id, 12)}, ${when(v.createdAt)}, ${plural(v.pickCount, "Pick")}, all settled by ${when(v.settleCutoff)}`,
      lessons: v.text.split("\n").map((l) => clampText(l, LESSON_CLAMP)).filter((l) => l !== ""),
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
