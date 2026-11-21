// The Research page (human researcher ticket 03): what GET /api/picks and POST /api/picks send, turned into the text the page shows. The contract
// address, the reason, the topic and the coin's name come from the Operator or from DexScreener: everything is cut to a line and shown as text only;
// the one link is the coin's DexScreener page, built here from an address that passed the base58 test.
import { ageText, clampText, fmtUsd } from "./meta.ts";

/** The form's limits: the same the server enforces (`PICK_REASON_MAX_CHARS`, `PICK_TOPIC_MAX_CHARS` in core; the server is the check). */
export const REASON_MAX_CHARS = 300;
export const TOPIC_MAX_CHARS = 60;
const NAME_CLAMP = 60;
const SYMBOL_CLAMP = 20;
const LINE_CLAMP = 300;
const MESSAGE_CLAMP = 240;
const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One Pick as GET /api/picks sends it (core's `ResearchPick`; a field renamed there is a type error in the server test). */
export interface PickPayload {
  id: number;
  ca: string;
  name: string;
  symbol: string;
  marketCapUsd: number | null;
  liquidityUsd: number;
  pairCreatedAt: string | null;
  ageMinutes: number | null;
  bondedAtPick: boolean;
  venue?: string;
  reason: string;
  topic: string;
  createdAt: string;
  source?: string;
  withdrawnAt?: string | null;
}

/** How long the Withdraw button stays (core's `PICK_WITHDRAW_MS`; the server is the check). */
export const WITHDRAW_WINDOW_MS = 10 * 60_000;

export interface PickRowView {
  /** The Operator withdrew it: shown struck through. */
  withdrawn: boolean;
  /** The Withdraw button shows: an Operator Pick, not withdrawn, younger than 10 minutes. */
  canWithdraw: boolean;
  id: number;
  title: string;
  ca: string;
  href: string | null;
  topic: string;
  reason: string;
  facts: string[];
  bonded: boolean;
  bondedLabel: string;
  outcome: OutcomeRowView;
  picked: string;
}

export interface PicksView {
  empty: string | null;
  summary: string;
  rows: PickRowView[];
  /** The bonding rate (ticket 04); null until the outcomes have loaded. */
  rate: RateView | null;
}

/** GET /api/pick-outcomes (core's `PickOutcomeView`; a field renamed there is a type error in the server test). */
export interface OutcomePayload {
  pickId: number;
  result: "pending" | "bonded" | "not-bonded" | "unknown" | "already-bonded";
  over: boolean;
  bondedAt: string | null;
  marks: { mark: string; state: "sampled" | "missed" | "waiting"; peakUsd: number | null }[];
}
export interface StatsPayload {
  bonded: number;
  finished: number;
  rate: number | null;
  alreadyBonded: number;
  unknown: number;
  pending: number;
}
export interface OutcomesPayload {
  outcomes: OutcomePayload[];
  all: StatsPayload;
  week: StatsPayload;
}

export interface OutcomeRowView {
  label: string;
  detail: string;
  marks: string[];
}
export interface RateView {
  all: string;
  week: string;
  /** The Picks left out of the rate, each with its own count. */
  leftOut: string;
}

/** "no finished Picks yet", or "40% bonded within 24h (2 of 5 finished Picks, n=5)": the rate always shows its n, and an empty set is never 0%. */
export function rateText(label: string, s: StatsPayload | null | undefined): string {
  const finished = finite(s?.finished) ? s.finished : 0;
  if (!s || finished === 0 || !finite(s.rate)) return `${label}: no finished Picks yet`;
  return `${label}: ${Math.round(s.rate * 100)}% bonded within 24h (${s.bonded} of ${finished} finished Picks, n=${finished})`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function rateView(o: OutcomesPayload | null | undefined): RateView | null {
  if (!o || typeof o.all !== "object" || typeof o.week !== "object" || o.all === null || o.week === null) return null;
  const a = o.all;
  const parts = [`${a.alreadyBonded ?? 0} already bonded at the Pick`, `${a.unknown ?? 0} unknown (coin vanished or could not be checked)`, `${a.pending ?? 0} pending`];
  return { all: rateText("All time", a), week: rateText("Last 7 days", o.week), leftOut: `Left out of the rate: ${parts.join(", ")}.` };
}

const MARK_LABEL: Record<string, string> = { "1h": "+1h", "6h": "+6h", "24h": "+24h" };

/** One Pick's outcome: "pending" until its 24 hours are over (with what is known so far), then bonded yes or no, and the peaks at each mark. */
export function outcomeView(o: OutcomePayload | null | undefined, nowMs: number): OutcomeRowView {
  if (!o) return { label: "pending", detail: "no outcome recorded yet", marks: [] };
  const marks = (Array.isArray(o.marks) ? o.marks : []).map((m) => `${MARK_LABEL[m.mark] ?? clampText(m.mark, 8)} ${m.state === "sampled" ? (finite(m.peakUsd) ? `peak ${fmtUsd(m.peakUsd)}` : "peak unknown") : m.state === "missed" ? "missed (not sampled in time)" : "waiting"}`);
  const so = o.bondedAt !== null && o.bondedAt !== undefined ? ` (bonded ${ageText(o.bondedAt, nowMs) ?? "at an unknown time"})` : "";
  switch (o.result) {
    case "already-bonded":
      return { label: "already bonded", detail: "had bonded before the Pick; left out of the rate", marks };
    case "unknown":
      return { label: "unknown", detail: "the coin vanished or could not be checked; left out of the rate", marks };
    case "bonded":
      return o.over ? { label: "bonded within 24h", detail: `yes${so}`, marks } : { label: "pending", detail: `bonded so far${so}; the 24 hours are not over`, marks };
    case "not-bonded":
      return o.over ? { label: "did not bond within 24h", detail: "no", marks } : { label: "pending", detail: "not bonded yet", marks };
    default:
      return { label: "pending", detail: o.over ? "the 24 hours are over; waiting for a lookup" : "the 24 hours are not over", marks };
  }
}

/** "5 minutes", "3 hours", "2 days": a coin's age at the Pick. */
export function ageSpan(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(Math.max(0, minutes), "minute");
  if (minutes < 48 * 60) return plural(Math.floor(minutes / 60), "hour");
  return plural(Math.floor(minutes / 1_440), "day");
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function picksView(rows: readonly PickPayload[] | null | undefined, nowMs: number, outcomes?: OutcomesPayload | null): PicksView {
  const list = Array.isArray(rows) ? rows.filter((r) => typeof r === "object" && r !== null && Number.isSafeInteger(r.id)) : [];
  const rate = rateView(outcomes);
  const byId = new Map((Array.isArray(outcomes?.outcomes) ? outcomes.outcomes : []).map((o) => [o.pickId, o]));
  if (list.length === 0) return { empty: "No Picks yet. Paste a contract address above to record the first.", summary: "", rows: [], rate };
  return {
    empty: null,
    rate,
    summary: `${list.length} ${list.length === 1 ? "Pick" : "Picks"} shown, newest first.`,
    rows: list.map((r) => {
      const name = clampText(r.name, NAME_CLAMP);
      const symbol = clampText(r.symbol, SYMBOL_CLAMP);
      const ca = clampText(r.ca, 60);
      const facts = [
        finite(r.marketCapUsd) ? `market cap ${fmtUsd(r.marketCapUsd)}` : "market cap unknown",
        finite(r.liquidityUsd) ? `liquidity ${fmtUsd(r.liquidityUsd)}` : "liquidity unknown",
        finite(r.ageMinutes) ? `age ${ageSpan(r.ageMinutes)} at the Pick` : "age unknown",
        ...(clampText(r.venue, 32) ? [`on ${clampText(r.venue, 32)}`] : []),
      ];
      const withdrawn = typeof r.withdrawnAt === "string";
      const madeMs = typeof r.createdAt === "string" ? Date.parse(r.createdAt) : Number.NaN;
      return {
        withdrawn,
        canWithdraw: !withdrawn && r.source !== "shadow" && Number.isFinite(madeMs) && nowMs - madeMs < WITHDRAW_WINDOW_MS,
        id: r.id,
        title: `${name || "(no name)"}${symbol ? ` ($${symbol})` : ""}`,
        ca,
        href: CA_RE.test(ca) ? `https://dexscreener.com/solana/${ca}` : null,
        topic: clampText(r.topic, TOPIC_MAX_CHARS),
        reason: clampText(r.reason, LINE_CLAMP),
        facts,
        bonded: r.bondedAtPick === true,
        bondedLabel: r.bondedAtPick === true ? "Bonded at pick" : "Not bonded at pick",
        outcome: outcomeView(byId.get(r.id) ?? (r.bondedAtPick === true ? { pickId: r.id, result: "already-bonded", over: false, bondedAt: null, marks: [] } : undefined), nowMs),
        picked: `picked ${(typeof r.createdAt === "string" ? ageText(r.createdAt, nowMs) : null) ?? "at an unknown time"}`,
      };
    }),
  };
}

/** Sends the withdrawal of one Pick (the page's `$fetch`). Never throws. */
export async function submitWithdraw(post: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await post();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: failureMessage(e) };
  }
}

/** What came back from a good POST /api/picks. */
export interface PickLinePayload {
  text: string;
  ok: boolean;
  message?: string;
  pickId?: number;
}
export interface PicksAccepted {
  lines: PickLinePayload[];
  skipped: number;
}

export interface PickLineView {
  text: string;
  ok: boolean;
  message: string;
}

/** The answer to a submit, one line per pasted address, in the order pasted. */
export function resultLines(r: PicksAccepted | null | undefined): { lines: PickLineView[]; note: string | null } {
  const raw = Array.isArray(r?.lines) ? r.lines : [];
  const lines = raw.map((l) => ({ text: clampText(l?.text, 60), ok: l?.ok === true, message: l?.ok === true ? `Recorded as Pick ${Number.isSafeInteger(l.pickId) ? l.pickId : ""}`.trim() : clampText(l?.message, MESSAGE_CLAMP) || "Not recorded" }));
  const skipped = finite(r?.skipped) ? r.skipped : 0;
  return { lines, note: skipped > 0 ? `${skipped} more ${skipped === 1 ? "address was" : "addresses were"} over the limit of 10 per paste and was not looked up.` : null };
}

/** Whether the submit button is on: some text that is not only blanks. */
export const canSubmitPicks = (text: string): boolean => text.trim() !== "";

/** The reason a failed `$fetch` carries, as one cut line of text. */
export function failureMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: unknown }; statusMessage?: unknown } | null;
  const reason = [err?.data?.statusMessage, err?.statusMessage].find((x) => typeof x === "string" && x !== "");
  return clampText(reason ?? "The request failed. Try again.", MESSAGE_CLAMP);
}

/** Sends the paste through `post` (the page's `$fetch`). Never throws. */
export async function submitPicks(post: (body: { text: string; reason: string; topic: string }) => Promise<PicksAccepted>, form: { text: string; reason: string; topic: string }): Promise<{ ok: true; lines: PickLineView[]; note: string | null } | { ok: false; message: string }> {
  try {
    const r = resultLines(await post(form));
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, message: failureMessage(e) };
  }
}
