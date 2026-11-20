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
  bonded: boolean;
  reason: string;
  topic: string;
  createdAt: string;
}

export interface PickRowView {
  id: number;
  title: string;
  ca: string;
  href: string | null;
  topic: string;
  reason: string;
  facts: string[];
  bonded: boolean;
  bondedLabel: string;
  picked: string;
}

export interface PicksView {
  empty: string | null;
  summary: string;
  rows: PickRowView[];
}

/** "5 minutes", "3 hours", "2 days": a coin's age at the Pick. */
export function ageSpan(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(Math.max(0, minutes), "minute");
  if (minutes < 48 * 60) return plural(Math.floor(minutes / 60), "hour");
  return plural(Math.floor(minutes / 1_440), "day");
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function picksView(rows: readonly PickPayload[] | null | undefined, nowMs: number): PicksView {
  const list = Array.isArray(rows) ? rows.filter((r) => typeof r === "object" && r !== null && Number.isSafeInteger(r.id)) : [];
  if (list.length === 0) return { empty: "No Picks yet. Paste a contract address above to record the first.", summary: "", rows: [] };
  return {
    empty: null,
    summary: `${list.length} ${list.length === 1 ? "Pick" : "Picks"} shown, newest first.`,
    rows: list.map((r) => {
      const name = clampText(r.name, NAME_CLAMP);
      const symbol = clampText(r.symbol, SYMBOL_CLAMP);
      const ca = clampText(r.ca, 60);
      const facts = [
        finite(r.marketCapUsd) ? `market cap ${fmtUsd(r.marketCapUsd)}` : "market cap unknown",
        finite(r.liquidityUsd) ? `liquidity ${fmtUsd(r.liquidityUsd)}` : "liquidity unknown",
        finite(r.ageMinutes) ? `age ${ageSpan(r.ageMinutes)} at the Pick` : "age unknown",
      ];
      return {
        id: r.id,
        title: `${name || "(no name)"}${symbol ? ` ($${symbol})` : ""}`,
        ca,
        href: CA_RE.test(ca) ? `https://dexscreener.com/solana/${ca}` : null,
        topic: clampText(r.topic, TOPIC_MAX_CHARS),
        reason: clampText(r.reason, LINE_CLAMP),
        facts,
        bonded: r.bonded === true,
        bondedLabel: r.bonded === true ? "Bonded" : "Not bonded",
        picked: `picked ${(typeof r.createdAt === "string" ? ageText(r.createdAt, nowMs) : null) ?? "at an unknown time"}`,
      };
    }),
  };
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
