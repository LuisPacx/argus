// The Research briefs on /research (human researcher ticket 05): what GET /api/research-requests sends, turned into the text the page shows. The topic
// is typed by the Operator; the story, the source titles and the coin notes are written by a model that read web pages and X posts; coin names come from
// DexScreener. All of it is untrusted: every field is cut to a line and shown as text only. A link is a source address that passes `safeHttpUrl`, or the
// DexScreener page of a coin whose address passed the base58 test. Never an element, never `v-html`.
import { angleStatusFor, failureReason, type AngleAccepted, type AngleRequestPayload, type AngleStatusView } from "./angle.ts";
import { failureMessage } from "./research.ts";
import { ageText, clampText, fmtUsd } from "./meta.ts";
import { safeHttpUrl } from "./safe-link.ts";

export const RESEARCH_TOPIC_MAX_CHARS = 80;
const STORY_CLAMP = 1_200;
const TITLE_CLAMP = 120;
const NOTE_CLAMP = 200;
const NAME_CLAMP = 60;
const SYMBOL_CLAMP = 20;
const DETAIL_CLAMP = 300;
const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** One request as GET /api/research-requests sends it (core's `ResearchRequestView`; a field renamed there is a type error in the server test). */
export interface BriefPayload {
  story: string;
  sources: { title: string; url: string | null }[];
  coins: { ca: string; name: string; symbol: string; marketCapUsd: number | null; liquidityUsd: number; bonded: "yes" | "no" | "unknown"; note: string }[];
  freeNames: { name: string; ticker: string; why: string; note: string }[];
  xNote: string;
  createdAt: string;
}
export interface ResearchRequestPayload {
  id: number;
  topic: string;
  status: "pending" | "running" | "done" | "failed" | "capped";
  detail: string;
  createdAt: string;
  doneAt: string | null;
  runs: number;
  costUsd: number;
  costEstimated: boolean;
  brief: BriefPayload | null;
}

export interface BriefCoinView {
  title: string;
  ca: string;
  href: string | null;
  facts: string;
  bonded: string;
  bondedClass: string;
  note: string;
}
export interface BriefView {
  story: string;
  /** `host` is where a clickable source goes, as plain text (null when the source has no web link). */
  sources: { title: string; href: string | null; host: string | null }[];
  coins: BriefCoinView[];
  noCoins: string;
  freeNames: { label: string; why: string; note: string }[];
  noFreeNames: string;
  xNote: string;
}
export interface ResearchRowView {
  id: number;
  topic: string;
  status: string;
  statusClass: string;
  detail: string;
  asked: string;
  /** "cost $0.1234", "cost $0.1234 (an estimate)" or "no run, no cost". Always there: the Operator sees what each request cost. */
  cost: string;
  brief: BriefView | null;
  /** The "Make ideas" button under the brief (human researcher ticket 06); null while there is no brief. */
  ideas: IdeasView | null;
}
/** What sits under a brief: the status of its newest Make ideas request (the same request table and status words as a Meta's) and the Proposals it filed. */
export interface IdeasView {
  status: AngleStatusView | null;
  /** Links to the Proposals the request filed, by their numeric ids only. */
  links: { text: string; href: string }[];
  /** True while the worker has the request (pending or running): the button waits. */
  waiting: boolean;
}
export interface ResearchRequestsView {
  empty: string | null;
  rows: ResearchRowView[];
}

const STATUS: Record<ResearchRequestPayload["status"], { label: string; pill: string }> = {
  pending: { label: "Waiting for the worker", pill: "pill-outline" },
  running: { label: "Researching", pill: "pill-accent" },
  done: { label: "Done", pill: "pill-green" },
  failed: { label: "Failed", pill: "pill-red" },
  capped: { label: "Capped", pill: "pill-amber" },
};

/** "cost $0.1234" to four places (a run costs cents), flagged when some run's cost is an estimate; "no run, no cost" when nothing ran. */
export function costText(runs: unknown, costUsd: unknown, estimated: unknown): string {
  const n = finite(runs) ? runs : 0;
  if (n === 0) return "no run, no cost";
  const run = n === 1 ? "1 run" : `${n} runs`;
  if (!finite(costUsd)) return `${run}, cost unknown`;
  return `${run}, cost $${costUsd.toFixed(4)}${estimated === true ? " (an estimate: a run has not reported its cost)" : ""}`;
}

const BONDED: Record<string, { label: string; pill: string }> = {
  yes: { label: "Bonded", pill: "pill-green" },
  no: { label: "Not bonded", pill: "pill-outline" },
  unknown: { label: "Bonded: unknown", pill: "pill-amber" },
};

const HOST_CLAMP = 60;

/**
 * The host a source link goes to, from the already normalised address (human researcher ticket 12): what the browser would connect to, port included.
 * An address written with look-alike letters is shown in its ASCII (punycode) form. A long host is cut at the front, never the end, because the end
 * is the part that says whose it is (`paypal.com.aaaa…aaaa.example.net` must not read as `paypal.com`).
 */
export function hostOf(href: string): string | null {
  let host: string;
  try {
    host = new URL(href).host;
  } catch {
    return null;
  }
  const flat = clampText(host, 1_000);
  const chars = [...flat];
  return chars.length > HOST_CLAMP ? `…${chars.slice(-HOST_CLAMP).join("")}` : flat;
}

function briefView(b: BriefPayload): BriefView {
  const coins = (Array.isArray(b.coins) ? b.coins : []).filter((c) => typeof c === "object" && c !== null).map((c) => {
    const ca = clampText(c.ca, 60);
    const bonded = BONDED[c.bonded] ?? BONDED.unknown!;
    const symbol = clampText(c.symbol, SYMBOL_CLAMP);
    return {
      title: `${clampText(c.name, NAME_CLAMP) || "(no name)"}${symbol ? ` ($${symbol})` : ""}`,
      ca,
      href: CA_RE.test(ca) ? `https://dexscreener.com/solana/${ca}` : null,
      facts: `${finite(c.marketCapUsd) ? `market cap ${fmtUsd(c.marketCapUsd)}` : "market cap unknown"}, ${finite(c.liquidityUsd) ? `liquidity ${fmtUsd(c.liquidityUsd)}` : "liquidity unknown"}`,
      bonded: bonded.label,
      bondedClass: bonded.pill,
      note: clampText(c.note, NOTE_CLAMP),
    };
  });
  const free = (Array.isArray(b.freeNames) ? b.freeNames : []).filter((n) => typeof n === "object" && n !== null);
  return {
    story: clampText(b.story, STORY_CLAMP),
    sources: (Array.isArray(b.sources) ? b.sources : []).filter((s) => typeof s === "object" && s !== null).map((s) => {
      const href = safeHttpUrl(s.url);
      return { title: clampText(s.title, TITLE_CLAMP) || "(untitled)", href, host: href === null ? null : hostOf(href) };
    }),
    coins,
    noCoins: coins.length === 0 ? "No coin on this topic was found or chosen." : "",
    freeNames: free.map((n) => ({ label: `${clampText(n.name, NAME_CLAMP)} ($${clampText(n.ticker, SYMBOL_CLAMP)})`, why: clampText(n.why, NOTE_CLAMP), note: clampText(n.note, NOTE_CLAMP) })),
    noFreeNames: free.length === 0 ? "No free name was offered, or every name offered is already used by a live token." : "",
    xNote: clampText(b.xNote, 200),
  };
}

/** The `meta_key` the worker gives the ideas of a brief (core's `topicKey`): the status line of a brief is the newest Make ideas request with this key. */
export const topicKeyOf = (researchRequestId: number): string => `topic:${researchRequestId}`;

function ideasView(r: ResearchRequestPayload, angles: readonly AngleRequestPayload[] | null | undefined, nowMs: number): IdeasView | null {
  if (!r.brief || typeof r.brief !== "object") return null;
  const key = topicKeyOf(r.id);
  const status = angleStatusFor(angles, key, nowMs);
  const rows: readonly AngleRequestPayload[] = Array.isArray(angles) ? angles : [];
  const newest = rows.find((x) => x?.metaKey === key);
  const ids = newest?.status === "done" && Array.isArray(newest.proposalIds) ? newest.proposalIds.filter((n) => Number.isSafeInteger(n) && n > 0) : [];
  return {
    status,
    links: ids.map((id, i) => ({ text: `Idea ${i + 1}`, href: `/proposals/${id}` })),
    waiting: newest?.status === "pending" || newest?.status === "running",
  };
}

/** `angles` is GET /api/meme-angle (the newest Make ideas requests, a Meta's and a brief's alike); without it no brief has a status line. */
export function researchRequestsView(rows: readonly ResearchRequestPayload[] | null | undefined, nowMs: number, angles?: readonly AngleRequestPayload[] | null): ResearchRequestsView {
  const list: ResearchRequestPayload[] = Array.isArray(rows) ? rows.filter((r) => typeof r === "object" && r !== null && Number.isSafeInteger(r.id)) : [];
  if (list.length === 0) return { empty: "No research yet. Type a topic above and press Research.", rows: [] };
  return {
    empty: null,
    rows: list.map((r) => {
      const status = STATUS[r.status] ?? { label: clampText(r.status, 20) || "Unknown", pill: "pill-outline" };
      return {
        id: r.id,
        topic: clampText(r.topic, RESEARCH_TOPIC_MAX_CHARS),
        status: status.label,
        statusClass: status.pill,
        detail: clampText(r.detail, DETAIL_CLAMP),
        asked: `asked ${(typeof r.createdAt === "string" ? ageText(r.createdAt, nowMs) : null) ?? "at an unknown time"}`,
        cost: costText(r.runs, r.costUsd, r.costEstimated),
        brief: r.brief && typeof r.brief === "object" ? briefView(r.brief) : null,
        ideas: ideasView(r, angles, nowMs),
      };
    }),
  };
}

/** Whether the Research button is on: a topic that is not only blanks. */
export const canSubmitTopic = (topic: string): boolean => topic.trim() !== "";

/** What came back from a good POST /api/research-requests. */
export interface TopicAccepted {
  id: number;
  status: string;
}

/** Sends the topic through `post` (the page's `$fetch`). Never throws. */
export async function submitTopic(post: (body: { topic: string }) => Promise<TopicAccepted>, topic: string): Promise<{ ok: true; note: string } | { ok: false; message: string }> {
  try {
    await post({ topic });
    return { ok: true, note: "Sent. The worker researches it next: this can take a few minutes." };
  } catch (e) {
    return { ok: false, message: failureMessage(e) };
  }
}

/** The "Make ideas" button under a brief (human researcher ticket 06): one POST /api/meme-angle with the research request id and no other key. Never throws. */
export async function submitTopicIdeas(post: (body: { researchRequestId: number }) => Promise<AngleAccepted>, researchRequestId: number): Promise<{ ok: true; note: string } | { ok: false; message: string }> {
  try {
    await post({ researchRequestId });
    return { ok: true, note: "Sent. The worker will write three ideas next." };
  } catch (e) {
    return { ok: false, message: failureReason(e) };
  }
}
