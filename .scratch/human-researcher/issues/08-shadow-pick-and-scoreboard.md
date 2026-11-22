# 08: Shadow pick and Scoreboard
**Model:** sonnet / high — the comparison must be fair, or the result means nothing.

**What to build:** Each Operator-triggered research run also makes the researcher choose its top coin or coins from the brief's coin list, without seeing the Operator's Picks. These Shadow picks are tracked exactly like Picks (ticket 04). A Scoreboard on the Research page compares the Operator's and the machine's bonded-within-24h rate over the last 7 days, each with n.

Fairness, defined:
- Same candidate set: the machine chooses only from the brief's coin list, and the Scoreboard counts an Operator Pick only if the coin was in a brief's list for that topic, or it shows the others in a separate row.
- Timestamped before the outcome: a Shadow pick is stored with its time when made, before its 24 hours start, and is never edited.
- The agent never sees Operator Picks, reasons or counts, and a test proves the prompt holds none. It DOES read the Playbook (ticket 09): that is how the machine learns. Leak guard: only a Playbook version built solely from Picks whose 24h outcome settled before the research request started, so the Operator's current and recent Picks cannot reach the Shadow pick. Each Shadow pick records the Playbook version it used (none if no eligible version exists).
- Like with like: an Operator Pick on a topic is compared with the machine's picks on the same topic.

**Blocked by:** 04, 05

Status: done

- [x] A research run files its Shadow picks from the brief's coin list only; a coin outside the list is rejected and the run ends with a repair retry (tests with a fake Brain).
- [x] The prompt and its inputs contain no raw Operator Pick, reason or Pick count (test inspects the rendered prompt with Picks present in the database). The only Operator-derived input is the Playbook version allowed by the leak guard: a test with a Pick settled after the request start and a Playbook built from it shows that version is not used, and a test shows an eligible version is used and its id stored on the Shadow pick.
- [x] Shadow picks are stored with their time before any outcome exists; an update or delete is refused by the database (tests).
- [x] Shadow picks get the same outcome job as Picks, and the same rules for already-bonded and unknown (reuse of ticket 04's tests).
- [x] The Scoreboard shows for 7 days: Operator rate and n, machine rate and n, the topics compared, and "not enough Picks yet" when either side has fewer than 20; it never shows a winner below that: the verdict threshold is 20 Picks per side, explicit in the code and on the page (render test).
- [x] Shadow picks are made only for Operator-triggered research: no scheduled path makes one (test).
- [x] Type-check, `pnpm lint` and `pnpm check` are green.

## Comments
