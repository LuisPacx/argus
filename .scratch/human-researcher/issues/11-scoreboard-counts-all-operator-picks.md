# 11: Scoreboard counts all Operator Picks
**Model:** sonnet / medium — one filter changes, and the rule it replaces must be stated plainly.

**What to build:** The Scoreboard counts every non-withdrawn Operator Pick made for a topic, not only coins that appeared in a brief's coin list. The machine has to beat the Operator as he really is, including the coins the researcher never listed. This replaces ticket 08's "same candidate set" rule for the Operator's side; the machine still chooses only from the brief's coin list, and the page says so.

Topic matching, defined: a Pick belongs to a topic when the topic typed on the Pick, cleaned the way a Pick stores it and compared without regard to letter case, equals the topic of a research request. Picks link to topics by that text today, not by an id. A Pick with no topic belongs to no topic and is listed apart, as now. Only topics on which both sides made a Pick are compared, and each side is counted over exactly those topics (unchanged). The verdict rule stays: no winner is named while either side has fewer than 20 Picks, explicit in the code and on the page. The page states in one line what is counted: every Operator Pick on those topics, withdrawn ones left out (ticket 10), against the machine's picks from the brief lists. Blocked by ticket 10 so that withdrawn Picks are already excluded.

**Blocked by:** 10

**Status:** done

- [x] An Operator Pick whose coin was in no brief's coin list is counted on its topic, in the Operator's rate and n (test with such a Pick).
- [x] A withdrawn Operator Pick is not counted (test).
- [x] Topic matching follows the stated rule: differences in letter case and surrounding space match, a different word does not, a Pick with no topic is never compared (tests).
- [x] Only topics where both sides picked are compared, and both sides are counted over exactly those topics (test).
- [x] The 20-per-side verdict rule is unchanged: below 20 on either side the page says "not enough Picks yet" and names no winner (render test).
- [x] The page states in one line what is counted, and the old row for Operator Picks outside the brief lists is gone (render test).
- [x] The Scoreboard is still read only: it calls no model and writes no row (test).
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
