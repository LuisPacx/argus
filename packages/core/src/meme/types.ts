import type { CollisionResult } from "../collision.ts";
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
 * The Meta as it was when the ideas were made: the ranking row, the run it came from, the Hot now event and the matching news, as stored.
 * Written once with the Proposal and never changed (a trigger refuses an update), so the card stays readable after the Meta moves and the
 * outcome tracking (missed-ideas/07) has the numbers at creation. All text in it is untrusted.
 */
export interface MetaSnapshot {
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
}
