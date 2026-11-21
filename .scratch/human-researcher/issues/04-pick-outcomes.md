# 04: Pick outcomes
**Model:** sonnet / medium — a scheduled plain-code job over a new table and one page section.

**What to build:** Each Pick is followed up without any Claude call. A scheduled plain-code job checks whether the coin bonded within 24 hours of the Pick and records the peak market cap at 1 hour, 6 hours and 24 hours after it. The Research page shows each Pick's outcome and the Operator's bonding rate (Picks that bonded within 24 hours over Picks whose 24 hours are over), always with n beside it.

**Data rules:** read the picks table directly, not `listPicks` (it caps at 50). Outcomes live in a separate table keyed on `pick_id`; the picks table stays immutable.

**Blocked by:** 03

**Status:** ready-for-agent

- [x] After 24 hours a Pick has a bonded yes or no, and the peak market caps at +1h, +6h and +24h; before that its outcome reads "pending" (tested with fake clocks and a fake DexScreener).
- [x] A coin that was already bonded at Pick time (`bonded_at_pick`) is excluded from "bonded within 24h" and reported separately with its own count, so it cannot inflate the rate (tested).
- [x] A lookup that fails is retried on the next tick and never marks a Pick as not bonded (tested); a Pick whose coin vanished ends `unknown` and is left out of the rate with its count shown.
- [x] The rate on the page is `bonded / finished` with n, for all time and for the last 7 days; an empty set reads "no finished Picks yet", not 0% (render test).
- [ ] The job makes no Claude call (test that the Brain fake is never touched) and is a no-op on a second run over finished Picks.
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
- 2026-11-20 cos: merged ad62d4e, 86f41c3, d7979b2 (two review rounds: label bias + request storm). Verifier PASS 223 files / 3551 tests; new tests fail on parent; page:check /research exit 0.
- Open: 'The job makes no Claude call ... no-op on a second run'. The no-op half is covered by 'a second run over finished Picks looks nothing up and writes nothing' (pick-outcomes.test.ts). The no-Brain half is not: the Brain Proxy in 'makes no Claude call' is created and never passed to the job (`void brain`), so it asserts nothing about a fake; only a source grep for brain/claude/spawn runs. Needs the fake wired into run() and asserted untouched. Status stays ready-for-agent.
