# 09: Remove the Meta code the redesign left unused
**Model:** sonnet / effort: medium. Deleting proven-dead code and its tests; no behaviour change.

**What to build:** delete what ticket 05 (top-down leader sources) left with no reader: the module `packages/core/src/meta/candidates.ts` (`trendingCandidate`, `trendingCandidates`, `TRENDING_SOURCE_ID`, `TrendingSignalRow`), the read method `store.meta.trendingSignals` (`packages/core/src/meta/store.ts`) and `marketCapFromSummary` with its private constants (`packages/core/src/sources/dexscreener.ts`).

**Status:** done

## Why each is unused (grep over the whole repo, 2026-11-17)

- `meta/candidates.ts`: imported only by its own test `candidates.test.ts` and by `meta/store.ts` (for `TRENDING_SOURCE_ID` and the `TrendingSignalRow` type, used only by `trendingSignals`). No tick, API or page imports it.
- `store.meta.trendingSignals`: a SQL read of the `signals` table (not a stored field, no column, no migration, no stored JSON), called only from `store.test.ts`. Nothing is persisted under that name, so an old database or file opens as before.
- `marketCapFromSummary`: called only by `candidates.ts` and by `dexscreener.test.ts`. `summarize` still writes `market cap $N` into the Signal summary text (a reader sees it); only the parser back is removed.

## Acceptance criteria

- [x] The three items above and their private helpers (`STAT_PREFIXES`, `MARKET_CAP_MARK`, `MAX_CAP_DIGITS`) are gone; `grep` for `meta/candidates`, `trendingSignals`, `marketCapFromSummary`, `TRENDING_SOURCE_ID` finds nothing under `packages/`, `apps/`, `scripts/`, `docs/`.
- [x] Tests that only tested removed code are deleted (`candidates.test.ts`, the `trendingSignals` store test, the `marketCapFromSummary` describe). Tests of `summarize` and the poller stay; their `marketCapFromSummary` expectations are replaced by the exact summary string where that is the point of the test.
- [x] Old stored data: no persisted field is removed, so no migration or read path changes.
- [x] Type-check and the full `pnpm check` pass, run once before the commit. Evidence: full `pnpm check` exit 0, "Test Files 160 passed (160), Tests 2618 passed (2618)" (2626 before; the 8 fewer are the deleted tests; not stamped because the tree was dirty when it started).

## Other dead code noticed, not removed

None found beyond the three items (only a search for the removed names was run, not a full unused-export scan). `summarize` in `dexscreener.ts` still writes the `market cap` and `FDV` text into the Signal summary; it is shown to readers, so it stays.

## Comments

- **Done 2026-11-17.** Removed `meta/candidates.ts` and its test, `trendingSignals` and its test, `marketCapFromSummary` and its tests.
