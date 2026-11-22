import type { CollisionResult } from "../collision.ts";
import type { OperatorAngle } from "./angle.ts";
import type { MetaWindow } from "../meta/config.ts";
import type { MetaCoverage } from "../meta/coverage.ts";
import type { MetaCounts, MetaTopToken } from "../meta/store.ts";

/**
 * The shapes of a `meme` Proposal (ADR 0013, missed ideas ticket 06). Types and constants only, so the datastore can store them and the
 * War Room can read them without pulling in the generation code.
 */

/** A trio is three ideas from one run. */
export const MEME_TRIO_SIZE = 3;
/** A Meta gets at most one trio in this long, whatever became of the last one (and the unique index holds one live trio per fixed window of this length). */
export const MEME_WINDOW_MS = 6 * 3_600_000;
/** A Meta that stays a Meta gets a fresh trio this long after its last try (ADR 0013, amended 2026-11-15); a new Meta does not wait for it. */
export const MEME_REFRESH_MS = 12 * 3_600_000;

/** A news-meme Narrative must have a Signal this recent (its newest Signal is under 12 h old). */
export const NEWS_MEME_LIVE_MS = 12 * 3_600_000;
/**
 * The floors a news Narrative's latest Score must reach to become a news meme (proposal-routing ticket 04, Q7), besides a buildability
 * below the gate: a story the Rubric called legitimate, with a hook, that is moving.
 */
export const NEWS_MEME_FLOORS = { legitimacy: 5, hook: 6, momentum: 6 } as const;
export type NewsMemeFloors = { readonly legitimacy: number; readonly hook: number; readonly momentum: number };

/** The `meta_key` of a news meme (a Proposal about a news Narrative, not a Meta): `narrative:<id>`. */
export const NEWS_MEME_KEY_PREFIX = "narrative:";
export const newsMemeKey = (narrativeId: number): string => `${NEWS_MEME_KEY_PREFIX}${narrativeId}`;

/** The idea fields of a `meme` Proposal beyond the name, ticker and description (those use the Proposal's own columns; the angle is `whyNow`). */
export interface MemeFields {
  /** Why the angle works and how it differs from the leader of the Meta (the leader's name is never copied). */
  difference: string;
  /** The first X post, as text. */
  hook: string;
  /** What the image would show, as text: argus makes no image. */
  imageIdea: string;
  /** Short plain-text labels such as "real person". Empty when the model named none and the Meta's subject is not a person. */
  riskLabels: string[];
  /**
   * Set when the name or ticker is also used by a dead or drained token on DexScreener (meta redesign ticket 16): one code-written line,
   * "name also used by a dead token: Dexter $2.9K". Absent when nothing was found; it never refuses the idea. The token name in it is creator text, cleaned and cut.
   */
  copyNote?: string;
}

/** One news headline as stored in the snapshot (third-party text, untrusted; the url is only safe to link after `safeHttpUrl`). */
export interface SnapshotNews {
  title: string;
  sourceLabel: string;
  url: string;
  publishedAt: string;
}

export interface SnapshotToken extends MetaTopToken {
  migrated: boolean;
}

/**
 * The Meta as it was when the ideas were made, as stored. Written once with the Proposal and never changed (a trigger refuses an update), so
 * the card stays readable after the Meta moves and the outcome tracking (missed-ideas/07) has the numbers at creation. All text in it is
 * untrusted. Three versions exist and all stay readable: version 1 (a launch-theme row and the Hot now event, up to Meta redesign ticket 03),
 * version 2 (a Meta, its leader token and what triggered the run) and version 3 (a news Narrative that failed the buildability gate, with its
 * Score and news; proposal-routing ticket 04). Readers branch on `version`.
 */
export type MetaSnapshot = MetaSnapshotV1 | MetaSnapshotV2 | NarrativeSnapshotV3 | TopicSnapshotV4;

/**
 * A topic as the ideas saw it (human researcher ticket 06, version 4): the topic the Operator typed and the Research brief the Operator pressed
 * Make ideas under, as they were. The topic is Operator-typed and the brief is model-written from web pages, X posts and DexScreener names, so
 * all of it is untrusted text. Readers branch on `version` and `kind`.
 */
export interface TopicSnapshotV4 {
  version: 4;
  kind: "topic";
  capturedAt: string;
  /** The research request the brief belongs to (`/research#research-<id>`), and the topic as typed (cleaned). */
  topic: { requestId: number; text: string };
  brief: {
    story: string;
    coins: { ca: string; name: string; symbol: string; marketCapUsd: number | null; bonded: "yes" | "no" | "unknown" }[];
    freeNames: { name: string; ticker: string }[];
    createdAt: string;
  };
  /** Code-written: `reason` names the topic and the brief's counts; `at` is when the Operator pressed the button. */
  trigger: { kind: "operator-topic"; reason: string; at: string };
}

/**
 * A news Narrative as the ideas saw it (proposal-routing ticket 04, version 3): a news story that failed the buildability gate and passed
 * the floors, with the failing Score and the news Signals as they were. Text is untrusted (headlines, the Narrative's summary and the
 * judge's reasons are written from third-party text).
 */
export interface NarrativeSnapshotV3 {
  version: 3;
  kind: "narrative";
  capturedAt: string;
  narrative: { id: number; title: string; summary: string; signalCount: number; createdAt: string; lastSignalAt: string };
  /** The Score the Narrative had when the ideas were made (the latest), its buildability below `gateMin`. */
  score: { id: number; rubricVersion: number; total: number; scores: Record<string, number>; rationale: string; gateMin: number; createdAt: string };
  /** Code-written: `reason` is "buildability 4 under the gate of 5; legitimacy 6, hook 8, momentum 9" and `at` is when that Score was made. */
  trigger: { kind: "news-meme"; reason: string; at: string };
  /** The news Signals of the Narrative (not market ones), newest first. */
  news: SnapshotNews[];
}

/** What started a version 2 run: a subject became a Meta, or it stayed one for `MEME_REFRESH_MS` since the last try. */
export type MemeTriggerKind = "new-meta" | "refresh";
/** What a stored version 2 snapshot says started the run: the two above, or the Operator's angle (ticket 11). */
export type MemeSnapshotTriggerKind = MemeTriggerKind | "operator-angle";

/** A Meta as the ideas saw it (meta redesign ticket 03): the Meta, its leader token and cap, what triggered the run, the matching news. */
export interface MetaSnapshotV2 {
  version: 2;
  capturedAt: string;
  meta: {
    key: string;
    label: string;
    /** When the subject became a Meta (carried from run to run). */
    enteredAt: string;
    /** True while its leader is between the stay and the enter market cap. */
    holding: boolean;
    counts: Record<MetaWindow, MetaCounts>;
    topTokens: MetaTopToken[];
    /** The stored one-line summary when there was a fresh one. */
    summary?: string;
  };
  /** The token that leads the Meta, with its market cap when the ideas were made. */
  leader: { mint: string; name: string; symbol: string; marketCapUsd: number };
  /** Code-written: `reason` is "$JENSEN at $2.4M, 14 creators in 24 h" and `at` is the event time (new Meta) or the start of the refresh slot. */
  trigger: { kind: MemeSnapshotTriggerKind; reason: string; at: string };
  run: { id: number; computedAt: string };
  /** The room-left ranking's verdict for the Meta at that run, as numbers-only text. An input to the prompt, never a gate. */
  roomLeft: { passed: boolean; text: string };
  /** The tokens the prompt showed (up to 8), the leader first. */
  tokens: SnapshotToken[];
  news: SnapshotNews[];
}

/** The Meta as it was when the ideas were made, Hot now era: the ranking row, the run it came from, the Hot now event and the matching news. */
export interface MetaSnapshotV1 {
  version: 1;
  capturedAt: string;
  meta: {
    key: string;
    label: string;
    rank: number;
    firstSeenAt: string;
    counts: Record<MetaWindow, MetaCounts>;
    topTokens: MetaTopToken[];
    marketCapUsd?: number;
    topMarketCapUsd?: number;
    /** The stored one-line summary when there was one. */
    summary?: string;
  };
  run: { id: number; computedAt: string; window: MetaWindow; baseMigrationRate: number | null; coverage: MetaCoverage | null };
  hot: { reason: string; raisedAt: string; rank: number; creators: number };
  /** The room-left ranking's verdict for the Meta at that run, as numbers-only text. An input to the prompt, never a gate. */
  roomLeft: { passed: boolean; text: string };
  /** The tokens the prompt showed (up to 8), top tokens first. */
  tokens: SnapshotToken[];
  news: SnapshotNews[];
}

/** A live idea as the Meta list shows it under its Meta: enough to read it and to open its card. Text is model-written and untrusted. */
export interface MemeIdeaRef {
  id: number;
  name: string;
  ticker: string;
  /** The joke and why now. */
  angle: string;
  status: "new" | "shortlisted";
  riskLabels: string[];
  createdAt: string;
  /** When it closes if nobody acts (ISO); null only for a status that never expires. */
  expiresAt: string | null;
  /** Present, and true, only for an idea made from the Operator's angle (ticket 11): the list draws an "Angle" pill. */
  fromAngle?: true;
}

/** One idea to store. The Proposal's name, ticker and description are the idea's; the angle is stored as `whyNow`. */
export interface NewMemeIdea extends MemeFields {
  name: string;
  ticker: string;
  angle: string;
  description: string;
  /** What the collision checks found for the name and ticker; absent when they were not run. */
  collisions?: CollisionResult;
}

export interface NewMemeTrio {
  /** Set for a news meme: the Narrative and the Score the trio was made from. They are stored on each Proposal (`narrative_id`, `score_id`), and `metaKey` is `narrative:<id>`. */
  narrative?: { id: number; scoreId: number };
  metaKey: string;
  metaLabel: string;
  snapshot: MetaSnapshot;
  /** Code-written line for the card's Why: what triggered the run. */
  reason: string;
  /** Code-written two-line summary of the Meta for the list. */
  summary: string;
  /** Code-built evidence links: the Meta's top tokens and the matching news. */
  evidenceLinks: string[];
  ideas: NewMemeIdea[];
  /**
   * Set for a trio made from the Operator's angle (ticket 11): stored on each Proposal. Such a trio is keyed by its request, not by the Meta's
   * 6 h window (`meme_window` is the request id, negated), so it neither blocks nor is blocked by the Meta's automatic trio.
   */
  operatorAngle?: OperatorAngle;
  /** The Playbook version (human researcher ticket 09) the prompt of the run carried, stored on each Proposal so a change in behaviour can be traced. */
  playbookVersion?: string;
  /** The Playbook version whose idea lessons the prompt carried (ticket 19), stored on each Proposal; can differ from `playbookVersion`. */
  ideasPlaybookVersion?: string;
}
