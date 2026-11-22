/**
 * The Christmas flicker of 2026-11-22 (War Room live runs 626 to 637), read from the live database once, read-only: the AI grouping answer of
 * each run (`meta_groupings`) cut down to the three Christmas themes, and the size of each theme in the last run (`meta_rows`). A fixture, not
 * a link to any database: `christmas-replay.test.ts` rebuilds the store from these figures.
 *
 * What the live runs did: 627 was a Meta (themes snowball, xmas, grinch; leader $snowball); the answer of 628 left snowball out and listed
 * Christmas {xmas} and Grinch {grinch}, so the subject lost its key to Grinch (the stabiliser tie, ticket 07) and the Meta ended; the answers
 * of 630 to 637 split snowball off for good; 637 was a Meta again and raised a second New Meta.
 */
export interface FixtureRun {
  run: number;
  at: string;
  /** The AI subjects that held at least one Christmas theme, each with the theme keys the answer put in it. */
  subjects: Array<{ name: string; themes: string[] }>;
}

/** Theme sizes at run 637 (24 h and 6 h creates and creators, graduations by create in 24 h). */
export const THEMES = {
  snowball: { tokens24: 27, creators24: 25, tokens6: 3, creators6: 3, migrations24: 3 },
  xmas: { tokens24: 34, creators24: 18, tokens6: 13, creators6: 7, migrations24: 0 },
  grinch: { tokens24: 8, creators24: 6, tokens6: 0, creators6: 0, migrations24: 0 },
} as const;

export const RUNS: FixtureRun[] = [
  { run: 626, at: "2026-11-22T19:52:39.190Z", subjects: [{ name: "Christmas", themes: ["xmas", "grinch"] }, { name: "Snowball", themes: ["snowball"] }] },
  { run: 627, at: "2026-11-22T20:07:39.191Z", subjects: [{ name: "Christmas", themes: ["snowball", "xmas", "grinch"] }] },
  { run: 628, at: "2026-11-22T20:22:39.191Z", subjects: [{ name: "Christmas", themes: ["xmas"] }, { name: "Grinch", themes: ["grinch"] }] },
  { run: 629, at: "2026-11-22T20:37:39.194Z", subjects: [{ name: "Christmas", themes: ["xmas", "grinch"] }] },
  { run: 630, at: "2026-11-22T20:52:39.195Z", subjects: [{ name: "Snowball", themes: ["snowball"] }, { name: "Christmas", themes: ["xmas"] }, { name: "Grinch", themes: ["grinch"] }] },
  { run: 631, at: "2026-11-22T21:07:39.195Z", subjects: [{ name: "Snowball", themes: ["snowball"] }, { name: "Christmas", themes: ["xmas"] }] },
  { run: 632, at: "2026-11-22T21:22:39.196Z", subjects: [{ name: "Christmas", themes: ["xmas"] }, { name: "Snowball", themes: ["snowball"] }] },
  { run: 633, at: "2026-11-22T21:37:39.196Z", subjects: [{ name: "Snowball", themes: ["snowball"] }, { name: "Christmas", themes: ["xmas"] }] },
  { run: 634, at: "2026-11-22T21:52:39.197Z", subjects: [{ name: "Christmas", themes: ["xmas"] }, { name: "Snowball", themes: ["snowball"] }] },
  { run: 635, at: "2026-11-22T22:07:39.196Z", subjects: [] },
  { run: 636, at: "2026-11-22T22:22:39.301Z", subjects: [{ name: "Snowball", themes: ["snowball"] }] },
  { run: 637, at: "2026-11-22T22:37:39.303Z", subjects: [{ name: "Snowball", themes: ["snowball"] }, { name: "Christmas", themes: ["xmas"] }] },
];
