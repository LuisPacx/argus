// What the War Room shows for a `meme` Proposal (ADR 0013, missed ideas ticket 06): the idea's fields, the Meta as it was when the idea was
// made (the stored snapshot) and the evidence links. Every string here is model-written (the idea), creator-written (token names) or
// third-party (headlines): it is cut here, rendered as text only, and a link exists only where `safeHttpUrl` accepted the URL.
import { ageText, clampText, tokenViews, type MetaTokenView } from "./meta.ts";
import { bareUrl } from "./format.ts";
import { safeHttpUrl } from "./safe-link.ts";

const NAME_CHARS = 40;
const TICKER_CHARS = 12;
const ANGLE_CHARS = 300;
const FIELD_CHARS = 300;
const HOOK_CHARS = 280;
const LABEL_CHARS = 30;
const LABELS_SHOWN = 5;
const META_LABEL_CHARS = 60;
const HEADLINE_CHARS = 160;
const SOURCE_CHARS = 40;
const NEWS_SHOWN = 5;
const EVIDENCE_SHOWN = 10;
const REASON_CHARS = 120;
const ROOM_LEFT_CHARS = 400;

/** What the card and the list read of a Proposal (the server's `Proposal`; a field renamed there is a type error in the server test). */
export interface MemeProposalPayload {
  kind?: string;
  status?: string;
  name: string;
  ticker: string;
  /** The idea's angle. */
  whyNow: string;
  description: string;
  /** Code-written: what triggered it ("Hot now: ..."). */
  reason: string;
  /** The code-written two-line Meta summary. */
  narrativeSummary: string;
  evidenceLinks: string[];
  metaLabel?: string | null;
  metaSnapshot?: {
    capturedAt?: string;
    meta?: { label?: string; rank?: number; firstSeenAt?: string; counts?: { "6h"?: Counts; "24h"?: Counts }; topTokens?: Array<{ mint?: string; name?: string; symbol?: string; marketCapUsd?: number }>; summary?: string };
    run?: { computedAt?: string };
    hot?: { reason?: string; raisedAt?: string; rank?: number; creators?: number };
    roomLeft?: { passed?: boolean; text?: string };
    news?: Array<{ title?: string; sourceLabel?: string; url?: string; publishedAt?: string }>;
  } | null;
  meme?: { difference?: string; hook?: string; imageIdea?: string; riskLabels?: string[] } | null;
}

interface Counts {
  tokens?: number;
  creators?: number;
  migrations?: number;
  migrationsAfter60s?: number;
}

export interface MemeNewsView {
  title: string;
  meta: string;
  href: string | null;
}

export interface MemeView {
  /** The two-line card title pieces. */
  name: string;
  ticker: string;
  angle: string;
  difference: string | null;
  description: string | null;
  hook: string | null;
  imageIdea: string | null;
  riskLabels: string[];
  /** Why it was made: "Hot now: creators 70 to 148 in 1 h". */
  reason: string | null;
  meta: {
    label: string;
    /** "rank 2 in the 24 h ranking", "148 creators", "256 tokens", "31 migrations (unfiltered)", "12 after 60 s". */
    numbers: string[];
    /** "Hot now: creators 70 to 148 in 1 h, raised 3 hours ago". */
    hot: string | null;
    /** "ranking from 12 minutes ago". */
    ranking: string | null;
    roomLeft: string | null;
    summary: string | null;
    tokens: MetaTokenView[];
  };
  news: MemeNewsView[];
  evidence: Array<{ text: string; href: string | null }>;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const present = (text: unknown, max: number): string | null => clampText(text, max) || null;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The labels of an idea, cut and at most five. */
export function riskLabelsOf(meme: MemeProposalPayload["meme"]): string[] {
  const raw = Array.isArray(meme?.riskLabels) ? meme.riskLabels : [];
  return raw.flatMap((l) => clampText(l, LABEL_CHARS) || []).slice(0, LABELS_SHOWN);
}

/** The whole card of a meme Proposal. Everything is optional in the payload and a missing piece is simply absent. */
export function memeView(p: MemeProposalPayload, nowMs: number): MemeView {
  const snap = p.metaSnapshot ?? null;
  const meta = snap?.meta;
  const c24 = meta?.counts?.["24h"];
  const numbers: string[] = [];
  if (finite(meta?.rank)) numbers.push(`rank ${meta.rank} in the 24 h ranking`);
  if (finite(c24?.creators)) numbers.push(plural(c24.creators, "creator"));
  if (finite(c24?.tokens)) numbers.push(plural(c24.tokens, "token"));
  if (finite(c24?.migrations)) numbers.push(`${plural(c24.migrations, "migration")} (unfiltered)`);
  if (finite(c24?.migrationsAfter60s)) numbers.push(`${c24.migrationsAfter60s} after 60 s`);
  const hotAge = typeof snap?.hot?.raisedAt === "string" ? ageText(snap.hot.raisedAt, nowMs) : null;
  const hotReason = clampText(snap?.hot?.reason, REASON_CHARS);
  const rankingAge = typeof snap?.run?.computedAt === "string" ? ageText(snap.run.computedAt, nowMs) : null;
  const tokens = tokenViews(
    (Array.isArray(meta?.topTokens) ? meta.topTokens : []).map((t) => ({
      name: t?.name ?? "",
      symbol: t?.symbol ?? "",
      ...(finite(t?.marketCapUsd) ? { marketCapUsd: t.marketCapUsd } : {}),
      // The same page the Meta list links, only for a plain address.
      ...(typeof t?.mint === "string" && BASE58.test(t.mint) ? { url: `https://dexscreener.com/solana/${t.mint}` } : {}),
    })),
  );
  const news = (Array.isArray(snap?.news) ? snap.news : []).slice(0, NEWS_SHOWN).flatMap((n): MemeNewsView[] => {
    const title = clampText(n?.title, HEADLINE_CHARS);
    if (title === "") return [];
    const source = clampText(n.sourceLabel, SOURCE_CHARS);
    const when = typeof n.publishedAt === "string" ? ageText(n.publishedAt, nowMs) : null;
    return [{ title, meta: [source, when].filter((s): s is string => s !== null && s !== "").join(", "), href: safeHttpUrl(n.url) }];
  });
  return {
    name: clampText(p.name, NAME_CHARS),
    ticker: clampText(p.ticker, TICKER_CHARS),
    angle: clampText(p.whyNow, ANGLE_CHARS),
    difference: present(p.meme?.difference, FIELD_CHARS),
    description: present(p.description, FIELD_CHARS),
    hook: present(p.meme?.hook, HOOK_CHARS),
    imageIdea: present(p.meme?.imageIdea, FIELD_CHARS),
    riskLabels: riskLabelsOf(p.meme),
    reason: present(p.reason, REASON_CHARS),
    meta: {
      label: clampText(p.metaLabel ?? meta?.label, META_LABEL_CHARS),
      numbers,
      hot: hotReason !== "" ? `Hot now: ${hotReason}${hotAge !== null ? `, raised ${hotAge}` : ""}` : null,
      ranking: rankingAge !== null ? `ranking from ${rankingAge}` : null,
      roomLeft: present(snap?.roomLeft?.text, ROOM_LEFT_CHARS),
      summary: present(meta?.summary, 200),
      tokens,
    },
    news,
    evidence: (Array.isArray(p.evidenceLinks) ? p.evidenceLinks : []).slice(0, EVIDENCE_SHOWN).map((l) => {
      const href = safeHttpUrl(l);
      return { text: href ? bareUrl(href) : clampText(l, 80), href };
    }),
  };
}

/** The row of the Proposals list for a meme: the Meta line, the angle and the risk labels, cut. */
export interface MemeRowView {
  metaLine: string;
  angle: string;
  riskLabels: string[];
}

export function memeRowView(p: MemeProposalPayload): MemeRowView {
  return { metaLine: clampText(p.narrativeSummary, 200), angle: clampText(p.whyNow, ANGLE_CHARS), riskLabels: riskLabelsOf(p.meme) };
}

/** An idea under a Meta on /meta (the API's `ideas`): a link to its card by its numeric id only, never by anything written by the model. */
export interface MetaIdeaPayload {
  id: number;
  name: string;
  ticker: string;
  angle: string;
  status: string;
  riskLabels: string[];
  expiresAt: string | null;
}

export interface MetaIdeaView {
  id: number;
  href: string;
  name: string;
  ticker: string;
  status: string;
  angle: string;
  riskLabels: string[];
  /** "closes in 5 h" for an idea in new, "shortlisted" for a shortlisted one. */
  expires: string | null;
}

/** The ideas shown under one Meta: only those with a whole-number id and a name, at most three (a trio). */
export function ideaViews(ideas: readonly MetaIdeaPayload[] | undefined, nowMs: number): MetaIdeaView[] {
  return (Array.isArray(ideas) ? ideas : []).slice(0, 6).flatMap((i): MetaIdeaView[] => {
    if (!Number.isSafeInteger(i?.id) || i.id <= 0) return [];
    const name = clampText(i.name, NAME_CHARS);
    if (name === "") return [];
    const left = typeof i.expiresAt === "string" ? Math.floor((Date.parse(i.expiresAt) - nowMs) / 60_000) : Number.NaN;
    const expires = i.status !== "new" || !Number.isFinite(left) ? (i.status === "shortlisted" ? "shortlisted" : null) : left <= 0 ? "closes on the next worker tick" : left < 60 ? `closes in ${left} min` : `closes in ${Math.floor(left / 60)} h`;
    return [{ id: i.id, href: `/proposals/${i.id}`, name, ticker: clampText(i.ticker, TICKER_CHARS), status: clampText(i.status, 20), angle: clampText(i.angle, ANGLE_CHARS), riskLabels: riskLabelsOf({ riskLabels: i.riskLabels }), expires }];
  });
}
