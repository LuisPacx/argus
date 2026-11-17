// What the War Room shows for a `meme` Proposal (ADR 0013, missed ideas ticket 06): the idea's fields, the Meta as it was when the idea was
// made (the stored snapshot) and the evidence links. Every string here is model-written (the idea), creator-written (token names) or
// third-party (headlines): it is cut here, rendered as text only, and a link exists only where `safeHttpUrl` accepted the URL.
import { ageText, clampText, tokenViews, type MetaTokenView } from "./meta.ts";
import { bareUrl, fmtUtc } from "./format.ts";
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
const REASONS_CHARS = 300;

/** What the card and the list read of a Proposal (the server's `Proposal`; a field renamed there is a type error in the server test). */
export interface MemeProposalPayload {
  kind?: string;
  status?: string;
  name: string;
  ticker: string;
  /** The idea's angle. */
  whyNow: string;
  description: string;
  /** Code-written: what triggered it ("New Meta: ...", "Meta refresh: ...", or "Hot now: ..." on an idea from before the redesign). */
  reason: string;
  /** The code-written two-line Meta summary. */
  narrativeSummary: string;
  evidenceLinks: string[];
  metaLabel?: string | null;
  /** Set on a news meme (version 3 snapshot): the Narrative the story is. Null on a Meta's idea. */
  narrativeId?: number | null;
  /** The stored versions: 1 (a launch-theme row and a Hot now event, kept as it was made), 2 (a Meta, its leader and its trigger) and 3 (a news Narrative that failed the buildability gate, with its Score). */
  metaSnapshot?: {
    version?: number;
    capturedAt?: string;
    /** Version 3 only. */
    kind?: string;
    narrative?: { id?: number; title?: string; summary?: string; signalCount?: number; createdAt?: string; lastSignalAt?: string };
    score?: { id?: number; total?: number; scores?: Record<string, number>; rationale?: string; gateMin?: number; createdAt?: string };
    meta?: { label?: string; rank?: number; firstSeenAt?: string; counts?: { "6h"?: Counts; "24h"?: Counts }; topTokens?: Array<{ mint?: string; name?: string; symbol?: string; marketCapUsd?: number }>; summary?: string };
    run?: { computedAt?: string };
    /** Version 1 only. */
    hot?: { reason?: string; raisedAt?: string; rank?: number; creators?: number };
    /** Version 2 only: the token that leads the Meta. */
    leader?: { mint?: string; name?: string; symbol?: string; marketCapUsd?: number };
    /** Version 2: what started the run, `reason` is "$JENSEN at $2.4M, 14 creators in 24 h". Version 3: `reason` is "buildability 4 under the gate of 5; legitimacy 6, hook 8, momentum 9". */
    trigger?: { kind?: string; reason?: string; at?: string };
    roomLeft?: { passed?: boolean; text?: string };
    news?: Array<{ title?: string; sourceLabel?: string; url?: string; publishedAt?: string }>;
  } | null;
  meme?: { difference?: string; hook?: string; imageIdea?: string; riskLabels?: string[] } | null;
  /** Set on an idea made from the Operator's angle (ticket 11): the text the Operator typed, and its link when there was a plain one. Operator-typed, so untrusted. */
  operatorAngle?: { requestId?: number; angle?: string; sourceUrl?: string | null; urlDropped?: boolean } | null;
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

/** A news meme's source: the story, a link to its Narrative and the Score it failed the gate with (all text cut; the link is a numeric id only). */
export interface FromNewsView {
  headline: string;
  /** "/narratives/12" for a whole-number Narrative id, else null. */
  href: string | null;
  /** "Narrative 12". */
  linkText: string;
  /** "Score 5.2 of 10: buildability 3 (under the gate of 5), legitimacy 6, hook 8, momentum 9". */
  score: string | null;
  /** The judge's reasons for that Score, cut. */
  reasons: string | null;
}

/** The Operator's angle an idea was made for: the text as a line, and the source as a link only when `safeHttpUrl` accepts it (else plain text, or a note that it was dropped). */
export interface OperatorAngleView {
  text: string;
  /** The normalised http(s) address, or null. */
  href: string | null;
  /** The address as shown: "www.rockstargames.com/VI/only-in-leonida" for a link; the cut text of an address that is not a plain http(s) one; null when there was none. */
  sourceText: string | null;
  /** True when the text had a link that was not a plain http(s) address and so was dropped when the request was stored. */
  dropped: boolean;
}

export interface MemeView {
  /** The Operator's angle this idea was made for (ticket 11); null on every other idea. */
  operatorAngle: OperatorAngleView | null;
  /** `news` for an idea made from a news story (version 3 snapshot), else `meta`. */
  source: "meta" | "news";
  /** The "from news: <headline>" part of a news meme; null on a Meta's idea. */
  fromNews: FromNewsView | null;
  /** The two-line card title pieces. */
  name: string;
  ticker: string;
  angle: string;
  difference: string | null;
  description: string | null;
  hook: string | null;
  imageIdea: string | null;
  riskLabels: string[];
  /** Why it was made: "New Meta: $JENSEN at $2.4M, 14 creators in 24 h" (an older idea: "Hot now: creators 70 to 148 in 1 h"). */
  reason: string | null;
  meta: {
    label: string;
    /** "led by Jensen Huang ($JENSEN) $2.4M" or, on an older idea, "rank 2 in the 24 h ranking"; then "148 creators", "256 tokens", "31 migrations (unfiltered)", "12 after 60 s". */
    numbers: string[];
    /** "New Meta: $JENSEN at $2.4M, 14 creators in 24 h, raised 3 hours ago", "Meta refresh: ..." or, on an older idea, "Hot now: creators 70 to 148 in 1 h, raised 3 hours ago". */
    trigger: string | null;
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

/** "Score 5.2 of 10: buildability 3 (under the gate of 5), legitimacy 6, hook 8, momentum 9": the Score a news meme failed the gate with, from numbers only. */
function scoreText(score: { total?: number; scores?: Record<string, number>; gateMin?: number } | undefined): string | null {
  if (!score) return null;
  const s = score.scores ?? {};
  const dim = (key: string, note = "") => (finite(s[key]) ? [`${key} ${s[key]}${note}`] : []);
  const parts = [...dim("buildability", finite(score.gateMin) ? ` (under the gate of ${score.gateMin})` : ""), ...dim("legitimacy"), ...dim("hook"), ...dim("momentum"), ...dim("novelty")];
  const total = finite(score.total) ? `Score ${score.total.toFixed(1)} of 10` : "Score";
  return parts.length > 0 ? `${total}: ${parts.join(", ")}` : finite(score.total) ? total : null;
}
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const present = (text: unknown, max: number): string | null => clampText(text, max) || null;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The labels of an idea, cut and at most five. */
export function riskLabelsOf(meme: MemeProposalPayload["meme"]): string[] {
  const raw = Array.isArray(meme?.riskLabels) ? meme.riskLabels : [];
  return raw.flatMap((l) => clampText(l, LABEL_CHARS) || []).slice(0, LABELS_SHOWN);
}

const ANGLE_TEXT_CHARS = 600;
const SOURCE_TEXT_CHARS = 80;

/** The Operator's angle as the card and the list draw it: text clamped to one line, the source a link only through `safeHttpUrl`. Null when the Proposal has none. */
export function operatorAngleView(a: MemeProposalPayload["operatorAngle"]): OperatorAngleView | null {
  if (typeof a !== "object" || a === null) return null;
  const text = clampText(a.angle, ANGLE_TEXT_CHARS);
  if (text === "") return null;
  const href = safeHttpUrl(a.sourceUrl);
  return { text, href, sourceText: href !== null ? bareUrl(href) : typeof a.sourceUrl === "string" && a.sourceUrl !== "" ? clampText(a.sourceUrl, SOURCE_TEXT_CHARS) : null, dropped: a.urlDropped === true };
}

/** The whole card of a meme Proposal. Everything is optional in the payload and a missing piece is simply absent. */
export function memeView(p: MemeProposalPayload, nowMs: number): MemeView {
  const snap = p.metaSnapshot ?? null;
  const meta = snap?.meta;
  const c24 = meta?.counts?.["24h"];
  const numbers: string[] = [];
  const leader = snap?.version === 2 && snap.leader ? tokenViews([{ name: snap.leader.name ?? "", symbol: snap.leader.symbol ?? "", ...(finite(snap.leader.marketCapUsd) ? { marketCapUsd: snap.leader.marketCapUsd } : {}) }])[0] : undefined;
  if (leader) numbers.push(`led by ${leader.text}`);
  else if (finite(meta?.rank)) numbers.push(`rank ${meta.rank} in the 24 h ranking`);
  if (finite(c24?.creators)) numbers.push(plural(c24.creators, "creator"));
  if (finite(c24?.tokens)) numbers.push(plural(c24.tokens, "token"));
  if (finite(c24?.migrations)) numbers.push(`${plural(c24.migrations, "migration")} (unfiltered)`);
  if (finite(c24?.migrationsAfter60s)) numbers.push(`${c24.migrationsAfter60s} after 60 s`);
  // What triggered it: a version 2 snapshot says "New Meta" or "Meta refresh", a version 1 snapshot (a Hot now idea) keeps its old wording.
  const fromStory = snap?.version === 3 && snap.kind === "narrative";
  const trig = snap?.version === 2 || fromStory ? snap.trigger : undefined;
  const triggerAt = trig?.at ?? snap?.hot?.raisedAt;
  const triggerAge = typeof triggerAt === "string" ? ageText(triggerAt, nowMs) : null;
  const triggerReason = clampText(trig?.reason ?? snap?.hot?.reason, REASON_CHARS);
  const triggerName = fromStory ? "News meme" : trig ? (trig.kind === "operator-angle" ? "Operator angle" : trig.kind === "refresh" ? "Meta refresh" : "New Meta") : "Hot now";
  const triggerVerb = fromStory ? "scored" : trig?.kind === "operator-angle" ? "asked" : trig?.kind === "refresh" ? "refreshed" : "raised";
  if (fromStory) {
    const story = snap.narrative;
    if (finite(story?.signalCount)) numbers.push(plural(story.signalCount, "Signal"));
    const newest = typeof story?.lastSignalAt === "string" ? ageText(story.lastSignalAt, nowMs) : null;
    if (newest !== null) numbers.push(`newest ${newest}`);
  }
  const narrativeId = typeof p.narrativeId === "number" ? p.narrativeId : snap?.narrative?.id;
  const fromNews: FromNewsView | null = fromStory
    ? {
        headline: clampText(snap.narrative?.title ?? p.metaLabel, HEADLINE_CHARS),
        href: typeof narrativeId === "number" && Number.isSafeInteger(narrativeId) && narrativeId > 0 ? `/narratives/${narrativeId}` : null,
        linkText: typeof narrativeId === "number" && Number.isSafeInteger(narrativeId) && narrativeId > 0 ? `Narrative ${narrativeId}` : "Narrative",
        score: scoreText(snap.score),
        reasons: present(snap.score?.rationale, REASONS_CHARS),
      }
    : null;
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
    operatorAngle: operatorAngleView(p.operatorAngle),
    source: fromStory ? "news" : "meta",
    fromNews,
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
      // A story's headline is the "from news" line, so the Meta block does not repeat it.
      label: fromStory ? "" : clampText(p.metaLabel ?? meta?.label, META_LABEL_CHARS),
      numbers,
      trigger: triggerReason !== "" ? `${triggerName}: ${triggerReason}${triggerAge !== null ? `, ${triggerVerb} ${triggerAge}` : ""}` : null,
      ranking: rankingAge !== null ? `ranking from ${rankingAge}` : null,
      roomLeft: present(snap?.roomLeft?.text, ROOM_LEFT_CHARS),
      summary: fromStory ? present(snap.narrative?.summary, 200) : present(meta?.summary, 200),
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
  /** True for an idea made from the Operator's angle (the list row's "Angle" pill; ticket 11). */
  fromOperatorAngle: boolean;
}

export function memeRowView(p: MemeProposalPayload): MemeRowView {
  return { metaLine: clampText(p.narrativeSummary, 200), angle: clampText(p.whyNow, ANGLE_CHARS), riskLabels: riskLabelsOf(p.meme), fromOperatorAngle: operatorAngleView(p.operatorAngle) !== null };
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
  /** True for an idea made from the Operator's angle (ticket 11). */
  fromAngle?: boolean;
}

export interface MetaIdeaView {
  id: number;
  /** True for an idea made from the Operator's angle: the "Angle" pill. */
  fromAngle: boolean;
  href: string;
  name: string;
  ticker: string;
  status: string;
  angle: string;
  riskLabels: string[];
  /** "closes in 5 h" (or "closes 17 Nov 04:10 UTC" before the client clock is set) for an idea in new, "shortlisted" for a shortlisted one. */
  expires: string | null;
}

/** The ideas shown under one Meta: only those with a whole-number id and a name, at most four trios (the automatic one or two, and the Operator's angles). */
export function ideaViews(ideas: readonly MetaIdeaPayload[] | undefined, nowMs: number): MetaIdeaView[] {
  return (Array.isArray(ideas) ? ideas : []).slice(0, 12).flatMap((i): MetaIdeaView[] => {
    if (!Number.isSafeInteger(i?.id) || i.id <= 0) return [];
    const name = clampText(i.name, NAME_CHARS);
    if (name === "") return [];
    const left = typeof i.expiresAt === "string" ? Math.floor((Date.parse(i.expiresAt) - nowMs) / 60_000) : Number.NaN;
    const expires =
      i.status !== "new" || !Number.isFinite(left)
        ? i.status === "shortlisted" ? "shortlisted" : null
        : nowMs <= 0 ? `closes ${fmtUtc(i.expiresAt ?? "")}`
        : left <= 0 ? "closes on the next worker tick"
        : left < 60 ? `closes in ${left} min`
        : `closes in ${Math.floor(left / 60)} h`;
    return [{ id: i.id, fromAngle: i.fromAngle === true, href: `/proposals/${i.id}`, name, ticker: clampText(i.ticker, TICKER_CHARS), status: clampText(i.status, 20), angle: clampText(i.angle, ANGLE_CHARS), riskLabels: riskLabelsOf({ riskLabels: i.riskLabels }), expires }];
  });
}
