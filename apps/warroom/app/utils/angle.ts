// The Operator's angle form on /meta (meta redesign ticket 11): what the status line under each Meta says, the counter, and the one POST. Every
// string that comes back from the server (a refusal reason) is cut and shown as text only; nothing here builds HTML or a link.
import { ageText, clampText } from "./meta.ts";

/** The form's limit: the same 600 characters the server enforces (`ANGLE_MAX_CHARS` in core; the server is the check, this is the counter). */
export const ANGLE_MAX_CHARS = 600;
const DETAIL_CHARS = 200;
const ERROR_CHARS = 200;

/** One row of GET /api/meme-angle (the server's `AngleRequestRow`; a field renamed there is a type error in the server test). */
export interface AngleRequestPayload {
  id: number;
  metaKey: string;
  status: string;
  detail: string;
  createdAt: string;
  doneAt: string | null;
  proposalIds: number[];
  urlDropped?: boolean;
}

export interface AngleStatusView {
  /** The line under the form: "Waiting for the worker, asked 3 minutes ago", "3 ideas filed", "Refused: no longer a Meta". */
  text: string;
  /** `wait` while the worker has it, `ok` when ideas were filed, `bad` for a refusal, a failure or a cap. */
  tone: "wait" | "ok" | "bad";
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** The status of the newest request for one Meta (the payload is newest first), or null when it has none. */
export function angleStatusFor(rows: readonly AngleRequestPayload[] | null | undefined, metaKey: string | undefined, nowMs: number): AngleStatusView | null {
  if (!Array.isArray(rows) || metaKey === undefined) return null;
  const r = rows.find((x) => x?.metaKey === metaKey);
  if (!r) return null;
  const detail = clampText(r.detail, DETAIL_CHARS);
  const age = typeof r.createdAt === "string" ? ageText(r.createdAt, nowMs) : null;
  const dropped = r.urlDropped === true ? " The link was dropped: it was not a plain http or https address." : "";
  switch (r.status) {
    case "pending":
      return { text: `Waiting for the worker${age !== null ? `, asked ${age}` : ""}.${dropped}`, tone: "wait" };
    case "running":
      return { text: `The worker is writing the ideas.${dropped}`, tone: "wait" };
    case "done": {
      const n = Array.isArray(r.proposalIds) ? r.proposalIds.length : 0;
      return { text: n > 0 ? `${plural(n, "idea")} filed${age !== null ? `, asked ${age}` : ""}.${dropped}` : `No ideas filed.${dropped}`, tone: n > 0 ? "ok" : "bad" };
    }
    case "refused":
      return { text: `Refused: ${detail || "the answer was not usable"}.${dropped}`, tone: "bad" };
    case "failed":
      return { text: `Failed: ${detail || "the run failed"}.${dropped}`, tone: "bad" };
    case "capped":
      return { text: `Not run, a cap was reached: ${detail || "a daily cap"}.${dropped}`, tone: "bad" };
    default:
      return null;
  }
}

/** "37 / 600" for the counter under the textarea; counts characters, not UTF-16 units, as the server does. */
export function angleCounter(draft: string): string {
  return `${[...draft].length} / ${ANGLE_MAX_CHARS}`;
}

/** Whether the submit button is on: some text that is not only blanks, within the limit. */
export function angleCanSubmit(draft: string): boolean {
  const n = [...draft.trim()].length;
  return n > 0 && n <= ANGLE_MAX_CHARS;
}

/** What came back from a good POST (the server's response). */
export interface AngleAccepted {
  id: number;
  status: string;
  sourceUrl: string | null;
  urlDropped: boolean;
}

export type AngleSubmit = { ok: true; note: string } | { ok: false; message: string };

/** The reason a failed `$fetch` carries, as one cut line of text; the server writes it in words (cap, duplicate, unknown Meta). */
export function failureReason(e: unknown): string {
  const err = e as { data?: { statusMessage?: unknown }; statusMessage?: unknown; message?: unknown } | null;
  const reason = [err?.data?.statusMessage, err?.statusMessage].find((x) => typeof x === "string" && x !== "");
  return clampText(reason ?? "The request failed. Try again.", ERROR_CHARS);
}

/** Sends one angle through `post` (the page's `$fetch`) and says what happened, in words. Never throws. */
export async function submitAngle(post: (body: { metaKey: string; angle: string }) => Promise<AngleAccepted>, metaKey: string, draft: string): Promise<AngleSubmit> {
  try {
    const r = await post({ metaKey, angle: draft });
    return { ok: true, note: r.urlDropped ? "Sent. The link in your text was dropped: it was not a plain http or https address." : "Sent. The worker will pick it up." };
  } catch (e) {
    return { ok: false, message: failureReason(e) };
  }
}
