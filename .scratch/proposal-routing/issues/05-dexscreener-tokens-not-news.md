# 05: DexScreener trending tokens do not found news Narratives (they route like launchpad Signals)
**Model:** sonnet / medium (one branch in the clustering pass, one read-side guard, tests, two ADR amendments; no new tables, no Brain task).

**What to build:** `dexscreener:trending` token Signals (`Name ($TICKER)`) are embedded and clustered like headlines (`narratives.ts:208-219`), so a news Narrative can be made of token names alone: legacy rows 3881 and 4059 are exactly that. The user approved on 2026-11-15 that DexScreener tokens stop being embedded into news Narratives and are routed the way launchpad Signals are (grouped by name and ticker, or kept out of Narratives). A news Narrative must not form from token names alone. This amends ADR 0007 (clustering) and ADR 0011 (what a market Signal does).

**Status:** ready (open questions below each carry a recommended answer; confirm Q1 before building)
**Blocked by:** 04

Origin: `.scratch/cos.md`, entry "LEGACY ROWS CHECK" (11-15), then "USER: ... write dexscreener-routing follow-up ticket (build after 04)". Follows `.scratch/proposal-routing/issues/04-news-meme-proposals.md`, whose acceptance criterion "a qualifying Narrative has at least one news Signal" is the read-side half of this rule; this ticket is the write side.

## What is there today (read 2026-11-15)

- **Kind is set at creation.** `createNarrative` (`datastore.ts:1360-1372`) writes `kind = 'launchpad'` only when the caller passes a `launchpad` argument, else `'news'`. A Narrative's kind never changes afterwards.
- **The caller.** `clusterNewSignals` (`narratives.ts:189-220`): a `pumpportal:events` Signal goes to `placeLaunchpadSignal` (`launchpad-cluster.ts:35`) and never to the embedder. Every other Source, DexScreener included, is embedded, joins the nearest news Narrative (`:208`), else tries `crossSourceTarget` (`:216`, which lets a DexScreener token join a launchpad Narrative that already holds its name, `launchpad-cluster.ts:100-108`), else **starts a news Narrative with `createNarrative` (`:219`)**. That last line is the bug: a token that matches nothing founds a news Narrative, and later tokens embed near it and join it.
- **Why launchpad routing does not catch it.** `parseLaunchpadSignal` (`launchpad-subject.ts:45`) returns undefined for any Source but `pumpportal:events`, so a DexScreener Signal given to `placeLaunchpadSignal` would stand alone with its raw title and no keys. The keying itself exists: `parseTokenTitle` and `launchpadKeys` (`launchpad-subject.ts`) already split `Name ($TICKER)` for `crossSourceTarget`.
- **DexScreener Signals are used in three places, only one of which needs Narratives.**
  1. **The market Signal of ADR 0011.** `HAS_MARKET_SIGNAL` (`datastore.ts:230`, used by `narrativesToJudge` `:1568`, `narrativesToPropose` `:1635`, the list's `has_market` `:1501`) is true when a Narrative holds a Signal whose Source is `market` (`source-class.ts`: `pumpportal:events`, `dexscreener:trending`). PumpPortal Signals only ever sit in launchpad Narratives, which are never judged. So **a DexScreener token inside a news Narrative is today the only way a news Narrative becomes eligible.** This is the load-bearing use.
  2. **Meta leaders (ADR 0014).** `trendingSignals` (`meta/store.ts:461`) reads `signals WHERE source_id = 'dexscreener:trending'` by `ingested_at`; `meta/candidates.ts` and `meta/leaders.ts` work on those rows and on the `tokenPairs` lookup. No Narrative is read. Unaffected by this ticket.
  3. **Market-cap summary and the meme pass.** `meta/summary*.ts`, `meta/prompt-block.ts` and `meme/pass.ts` take the leader and cap from the Meta run and from `dexCopies` (a live DexScreener search). They read no Narrative either. Unaffected.
  Also: `meta/store.ts:450` excludes market Sources from the headline reader, so headlines are unaffected by where tokens sit.
- **Legacy rows.** 351, 3881 and 4059 predate the launchpad kind (593e290; first launchpad row 4245). 3881 and 4059 are DexScreener-only news Narratives. They age out of the join window; nothing has to be rewritten.

## What must keep working

- Meta ranking, leaders, Watching, the market-cap summary and meme pass: unchanged, because they read Signals by Source, not Narratives. A test pins that `trendingSignals` still returns Signals however they are clustered.
- A news Narrative that has a headline (a non-market Signal) and a DexScreener token is still "market-eligible" (ADR 0011). A real story with a token riding it is the case the rule exists for.
- Launchpad clustering and the cross-source join of a token into a launchpad Narrative by name (`crossSourceTarget`) are unchanged.
- Signals are never lost: every DexScreener Signal still ends up in some Narrative (`unclusteredSignals` must not stall on a token that cannot be placed).

## Approach (the smallest change that fits)

1. **Never found a news Narrative from a DexScreener token** (`narratives.ts`, the DexScreener case only). Order stays: nearest news Narrative (`:208`) -> `crossSourceTarget` launchpad claim (`:216`) -> **new:** start a launchpad-kind Narrative keyed by the token's name (and ticker), through a small helper beside `placeLaunchpadSignal` that builds `{ title, keys }` from `parseTokenTitle` / `launchpadKeys` and calls `createNarrative(..., launchpad)`. A token with no usable keys (generic or empty) stands alone as a launchpad-kind Narrative of one, as in `alone()`. Never `createNarrative` without the launchpad argument for a DexScreener Signal.
2. **Tokens may still join an existing news Narrative** (Q1 below). Since a news Narrative is now always founded by a non-market Signal, a news Narrative holding a token holds at least one headline, which is what ADR 0011 wanted.
3. **Read-side guard.** Add `HAS_NEWS_SIGNAL` (an `EXISTS` on a Signal whose `source_id NOT IN` the market list) next to `HAS_MARKET_SIGNAL` and require both in `narrativesToJudge` and `narrativesToPropose` (and in 04's `narrativesToMeme`, which should reuse it rather than define its own). This keeps the legacy token-only news rows out for good and protects against any later regression of step 1. Share one definition with 04.
4. **No backfill, no migration.** Legacy token-only news rows stay as they are; the guard hides them from judge and propose, and they leave the window. (Q3.)
5. **Docs.** ADR 0011 amendment: a market Signal makes a *news* Narrative eligible only together with at least one non-market Signal; a token never founds a news Narrative. ADR 0007 amendment: DexScreener tokens are grouped by name like launchpad Signals when they match no news Narrative. GLOSSARY (**Narrative**, **Signal**) and `docs/architecture.md` agree; `pnpm docs:graph` if the pipeline graph names the edge.

## Open design questions (recommended answer first)

1. **Do tokens keep joining existing news Narratives, or are they kept out entirely?** Recommend: keep joining, never found. If tokens were kept out of news Narratives completely, no news Narrative would ever hold a market Signal (PumpPortal never joins news), so ADR 0011 would judge nothing and the whole Tech path would stop. Keeping them out entirely is only possible with a different market-evidence rule (for example, a headline that names a token a Meta or DexScreener lists), which is a bigger design and its own ticket. **Needs the user's confirmation**, because "stop being embedded into news Narratives" can be read the stricter way.
2. **Where does an unmatched token go: a launchpad-kind Narrative keyed by name, or unclustered with a marker?** Recommend: launchpad-kind Narrative keyed by name and ticker. It reuses `createNarrative`'s launchpad path and the key claims, repeated trending tokens of the same name then group instead of piling up as singletons, and nothing is left unclustered.
3. **Backfill the legacy token-only news rows (3881, 4059)?** Recommend: no. They are two rows, they age out, and the `HAS_NEWS_SIGNAL` guard already stops them being judged, proposed or made into a news meme.
4. **Should the guard also apply to judge and propose, or only to 04's meme path?** Recommend: all three, one shared fragment. A token-only news Narrative must not be judged either (that costs a Brain run for no story).
5. **Should a token join a news Narrative that has no news Signal yet (a legacy token-only one still inside the window)?** Recommend: no special case. Leave `recentNarratives` as it is; such a Narrative stays ineligible through the guard and ages out. Excluding it from candidates would add a query for two rows.
6. **Eligibility volume.** Recommend: measure before shipping, on a copy of the database (home disk, not `/tmp`): how many currently judged or proposed news Narratives held a DexScreener token and no other market Signal, and how many of those had no headline. Expect the second figure to be near zero. If it is not, stop and ask: the ADR 0011 consequence is larger than assumed.
7. **Is the cross-source join order right (news first, then launchpad claim)?** Recommend: leave it. A token that matches a news Narrative by embedding joins it as before; the launchpad claim and the new launchpad Narrative only catch what no news Narrative wanted.

## Acceptance criteria

- [ ] A DexScreener token that matches no news Narrative and no launchpad claim starts a `kind = 'launchpad'` Narrative with its name (and ticker) keys, not a news one; a second token of the same name joins it; a token with no usable keys stands alone as launchpad-kind. Tests in `narratives.test.ts` (or the clustering test file it uses).
- [ ] A DexScreener token near an existing news Narrative still joins it; a token whose name a launchpad Narrative holds still joins that one (`crossSourceTarget` unchanged).
- [ ] No news Narrative is created with only market-Source Signals: a pass over several tokens and no headlines creates no `kind = 'news'` row.
- [ ] `narrativesToJudge`, `narrativesToPropose` and 04's `narrativesToMeme` require at least one non-market Signal as well as a market one, through one shared `HAS_NEWS_SIGNAL` fragment. Tests in `propose-store.test.ts`: a token-only news Narrative (legacy shape) is returned by none; the same Narrative with one headline Signal added is returned by the judge and propose selectors.
- [ ] Meta leaders are unchanged: `trendingSignals` returns the same Signals before and after, and a Meta run over a fixture is identical (`meta/` tests pass untouched).
- [ ] The measurement of Q6 is in the ticket's Comments before the commit.
- [ ] ADR 0007 and ADR 0011 amended; GLOSSARY and `docs/architecture.md` agree.
- [ ] Full `pnpm check` once before the commit.

## Constraints

- No change to Source classes (`source-class.ts`): DexScreener stays `market`.
- No change to Meta, summary or meme code, no new Brain task, no new table, no migration.
- Keys come from `launchpad-subject.ts` and `meta/key.ts`; no RegExp built from a token name.
- Commit subject `Proposal routing ticket 05: DexScreener tokens do not form news Narratives`, body ends with `Ticket: .scratch/proposal-routing/issues/05-dexscreener-tokens-not-news.md` before the trailers. No `Closes #N`.

## Comments

- **Written 2026-11-15** from the user's approval of the DexScreener routing follow-up (cos journal "LEGACY ROWS CHECK" and "USER: ... write dexscreener-routing follow-up ticket"). Build after 04.
