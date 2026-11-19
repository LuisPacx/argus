# 09: Coin-side list: the topic's top coins matched to Moments
**Model:** sonnet / medium. Code over data the trace and the Meta pipeline already read; no model.

**What to build:** the manual scans' "coin-side top list" as a page block per topic: the biggest coins of the topic by market cap, created after the topic's start, each tied to the Moment it rides (by the Moment's judge phrases) or marked "no moment" (a release-brand coin such as Rockstar Games at $943K, which rides the release, not a clip). Useful alone: the Operator sees at a glance which Moments already have a winning coin and which big coins have no Moment (the signal that the scanner missed one).

**Status:** ready-for-agent

**Blocked by:** 04.

## Design

- **Source of coins:** the topic's spellings and the Moments' phrases searched on DexScreener through the existing client (the search ticket 04 already runs; reuse its results where the same search was made this scan), plus the top-down candidates and launch themes the Meta pipeline already holds for a topic that came from a Meta (`meta/topdown.ts` candidates; no new request for them). Solana only, created at or after the topic's start, classed real or lookalike by ticket 04's rule; list the top 10 real by market cap and the lookalikes collapsed.
- **Matching:** a coin rides a Moment when ticket 04's name match holds for any of its phrases; a coin that matches no Moment is `no moment`; one that matches two is attached to the one whose first flag is earlier and shows both. A coin whose match is only the topic's own spelling (GTA VI, Vice City, Rockstar) is labelled `topic` (rides the setting), not `no moment`.
- **Missed-moment hint:** a real coin of $20,000 or more with `no moment` and a name that is not a topic spelling raises a "coin with no Moment" row at the top, which is a nudge for the Operator to search X for it by hand. Plain code, no model, one DexScreener-sourced line.
- **Store:** `moment_coin_list` rows per scan (coin, cap, liquidity, volume, class, matched Moment or label, scanned at), append only, last 48 hours kept.

## Acceptance criteria

- [ ] **Matching** (`coin-list.test.ts`, pairs transcribed from `.scratch/research/gta6-post-release.md`, "Coin-side top list" at 15:25, labelled transcribed): AL "Alien" ($26.4K) matches the Area 51 Moment; HULK ($23.3K, $20.9K, $18.1K) matches the Hulk Moment and the three are one row group; "Rockstar Games" ($943K), GTA6 "GTA VI" ($105.6K), "Vice city" ($16.6K) and State of Leonida are `topic`; "Grand Theft Alleycat" with $901K volume and a $1.7K cap is a lookalike; PIPITOAD ($101K, "surfaced in the Area 51 search, not checked") has no match and is a "coin with no Moment" row.
- [ ] **Rules:** created before the topic's start is excluded; an `unpriced` pair is a lookalike; the top-10 cut and the collapse of lookalikes hold; a coin matching two Moments is attached to the earlier-flagged one.
- [ ] **Pass** (`coin-list-pass.test.ts`): no extra DexScreener request beyond ticket 04's cap of 10 searches a scan when results are shared; a failed search keeps the last list marked stale; rows older than 48 hours are dropped.
- [ ] **Page** (`pnpm page:check --seed /moments`, seeded; say so): the list per topic with cap, liquidity, label and the Moment link, the "coin with no Moment" row first, lookalikes collapsed; hostile token names escaped; DexScreener links only through `safeHttpUrl`; no overflow at 390 or 1240 px.
- [ ] Type-check, `pnpm lint` and the full `pnpm check` pass, run once before the commit.

## Constraints

- Read-only DexScreener through the existing client. No new data source, no model. Names are third-party text.
- Commit subject `Moment scanner ticket 09: coin-side list`, body ends with `Ticket: .scratch/moment-scanner/issues/09-coin-side-list.md`.

## Comments
