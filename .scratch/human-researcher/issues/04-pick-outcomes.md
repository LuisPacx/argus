# 04: Pick outcomes
**Model:** sonnet / medium — a scheduled plain-code job over a new table and one page section.

**What to build:** Each Pick is followed up without any Claude call. A scheduled plain-code job checks whether the coin bonded within 24 hours of the Pick and records the peak market cap at 1 hour, 6 hours and 24 hours after it. The Research page shows each Pick's outcome and the Operator's bonding rate (Picks that bonded within 24 hours over Picks whose 24 hours are over), always with n beside it.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] After 24 hours a Pick has a bonded yes or no, and the peak market caps at +1h, +6h and +24h; before that its outcome reads "pending" (tested with fake clocks and a fake DexScreener).
- [ ] A coin that was already bonded at Pick time is recorded as such and counted separately, so it cannot inflate the rate (tested).
- [ ] A lookup that fails is retried on the next tick and never marks a Pick as not bonded (tested); a Pick whose coin vanished ends `unknown` and is left out of the rate with its count shown.
- [ ] The rate on the page is `bonded / finished` with n, for all time and for the last 7 days; an empty set reads "no finished Picks yet", not 0% (render test).
- [ ] The job makes no Claude call (test that the Brain fake is never touched) and is a no-op on a second run over finished Picks.
- [ ] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
