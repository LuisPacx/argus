# 14: a DexScreener pair with no figures is "unpriced", skipped, and the list's GeckoTerminal figures stand in
**Model:** sonnet / medium. Two small changes on one path (the pair parser and `verifyAgainstDex`) and one log rule, with exact tests.

**What to build:** a live, heavily traded token must not be rejected as unverifiable because DexScreener cannot price its pair. GTAVI (`ERiM8NiCanarGEnWMnURAoxTuTvUXZbtJsPTirnHpump`) migrated to pumpswap on 2026-11-17 19:13Z. Its only pair from `GET /tokens/v1/solana/<mint>` is quoted in another token (GTA6, not SOL), so DexScreener answers `volume: {}` and no liquidity, marketCap or fdv. `DexScreenerClient.pairs()` turned those into 0 / undefined and `verifyAgainstDex` (`meta/topdown.ts`) rejected it with "liquidity missing; market cap missing; 24 h volume missing", logged every tick (about 138 lines since 2026-11-17 19:27Z; CSI has the same signature). GeckoTerminal shows the pool at about $56.6K liquidity, $1.1M 24 h volume and $260K FDV. Diagnosis: `.scratch/cos.md`, "11-19 GTAVI diagnosis"; go-ahead: "11-19 USER yes ticket+build both".

**Status:** done

**Blocked by:** none. Ticket 13 (wrong leader of the GTA 6 Meta) edits `packages/core/src/meta/` too: merge 13 first, rebase this one if needed.

## Acceptance criteria

- [x] A pair with no liquidity, 24 h volume, market cap or FDV is "unpriced" (`DexPair.unpriced`, set by the parser) and skipped by verification, never read as 0 and never summed with priced pairs.
- [x] If every pair of the token is unpriced, the list's figures (market cap, liquidity, 24 h volume: the GeckoTerminal figures the candidate row already carries) are used when all three are present and pass the same tests. Otherwise the reason is the one "no priced DexScreener pair".
- [x] The same mint failing for the same reason is logged once, not every tick; a change of reason logs again, and a pass resets it.
- [x] Tests use a real-shaped fixture of this pair response (`packages/core/src/fixtures/dexscreener-unpriced-pair.json`) and fail on the parent commit.
- [x] The existing verification rules (cap over 100x liquidity, minimum liquidity and volume, the organic-score credit) still apply to priced data, and to the list figures used as the fallback.
- [x] Type-check and the full `pnpm check` pass, run once before the commit.

## Comments

- **Built 2026-11-19.** `sources/dexscreener.ts` (the `unpriced` flag), `meta/topdown.ts` (`verifyAgainstDex` filter and fallback), `meta/compute.ts` (list figures passed through; log-once memo per log function). Fixture: the pair shape is as DexScreener returns it for the GTAVI pair; the quote-token address is a placeholder.
- A token verified from list figures carries no DexScreener figure, so its cap is the list's (GeckoTerminal FDV, or Jupiter's when it is on both lists).
- Post-deploy (not a test): after the restart, `grep -c "GTAVI failed verification" <worker log>` should stop growing, and GTAVI should hold a leader cap in the next run.
