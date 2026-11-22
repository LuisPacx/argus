# A Meta exits slowly, and a returning Meta is not new twice

Status: accepted (Christmas fix, ticket 07; 2026-11-22). Amends ADR 0018 item on staying a Meta, and the New Meta event of meta-redesign ticket 03. Builds on the stabiliser of ADR 0019.

The live Christmas Meta of 2026-11-22 was a Meta at run 627, was gone at run 628, stayed in Watching for nine runs at 4 to 8 graduations (below the enter bar of 10) and became a Meta again at run 637, which raised a second New Meta for the same narrative.

## What happened (replayed from the live runs 626 to 637)

1. The cause of the drop was a stabiliser tie, not a dip in the market. At run 628 the AI answered Christmas {xmas} and Grinch {grinch} where run 627 had Christmas {snowball, xmas, grinch}. Both new subjects shared one theme with the previous subject, so the overlaps were equal, and the tie was decided by the smaller derived key: `grinch` before `xmas`. The Grinch subject inherited the key `xmas`, the snowball theme (which the answer left out) came back with it, and Christmas became `xmas-2` with 8 graduations. The carried Meta `xmas` was now a 3-graduation subject, below the stay bar, and ended. `xmas-2` was only Watching (8 is below 10).
2. $snowball leaving the subject was not itself the cause. A Meta is continued by its key (`byKey`), not by its leader; the leader is re-chosen each run from the subject's own graduates and tokens. When the AI split Snowball off at run 630, `xmas` kept its entry time and its Meta state as long as it kept the key. The key is what was lost, in item 1.
3. When the key held again, the same subject was at 8 graduations and Watching, and the next graduations took it over 10 at run 637 as a new Meta.

## Decision

1. **The stabiliser tie-break is by identity, then weight.** Among candidates with the same overlap, the subject that holds the theme the previous subject was keyed by wins, then the one with more creators behind the shared themes, then (as before) the smaller previous key and the smaller derived key. The order of the answer still never matters.
2. **Exit hysteresis, by time.** A Meta that falls below the stay bar (`ARGUS_META_STAY_GRADS`, 5 in 24 h) is kept, marked holding, until it has been below that bar for `ARGUS_META_EXIT_MINUTES` (default 45: three runs of the 15-minute tick). It then drops to Watching or out as before. The clock is `belowStaySince` on the stored row (in the `meta_current.counts` JSON, no schema change), starts the first run it is seen below the bar and is cleared the moment the bar is met again. A subject with no graduations in 24 h has no row to keep and ends at once; the cooling Meta still counts against `ARGUS_META_MAX_METAS`.
3. **A Meta is new once per window.** A key raised as a New Meta within `ARGUS_META_REENTRY_MINUTES` (default 360, the life of the event in the War Room) is not raised again when it re-enters. A key never raised, or last raised longer ago, is new. 0 turns the guard off.
4. **The leader is not the identity.** Unchanged and now tested: the Meta follows the subject's key, so its leader leaving (Snowball, then Xmas) does not end it.

Plain code decides Metas (ADR 0012); no model call is added. Nothing launches or signs (ADR 0002). No schema change.

## Considered options

- **A lower exit bar than 5.** Rejected: the stay bar already is the lower bar (5 against 10), and a lower one makes a Meta last on a trickle. Time below the bar is what a flicker needs.
- **N consecutive runs below.** Equivalent to the time rule at a fixed tick; the minutes rule survives a changed `ARGUS_META_INTERVAL` and a missed run.
- **Suppress the second event for ever.** Rejected: a narrative back after a day is news again. The 6 h guard matches how long an event stays live.

## Consequences

- A Meta that dips for up to 45 minutes stays a Meta, shown as holding; a Meta that really faded leaves 45 minutes later than before.
- The Christmas replay (live runs 626 to 637) is one Meta episode and one New Meta event, and fails on the old tie-break.
