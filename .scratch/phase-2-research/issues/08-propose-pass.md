# 08: Propose pass
**Model:** sonnet / high — turns Scores into Proposals under daily and usage caps.

**What to build:** Narratives above the buildability gate become Proposals through the `propose` task: proposed name, ticker, description, Tech one-liner, "why now" and 3 to 5 evidence links. At most 10 new Proposals per day, and research (judge plus propose) is held to about 30% of the daily subscription usage so it cannot starve Builds. Cards show Score bars and Narrative age.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] A `propose` skill returns validated Proposal fields; evidence links pass the existing link validation
- [ ] Only Narratives above the gate are proposed, and each Narrative at most once
- [ ] A hard cap of 10 new Proposals per day, in code; tested
- [ ] The research usage share (about 30%, measured in Est. usage) is enforced in code and visible in the War Room; when it is reached, research waits for the next day; tested
- [ ] Cards show Score bars per dimension, Narrative age, "why now" and the Tech
- [ ] The same Brain guarantees as Spec drafting; the fake `claude` in tests
- [ ] `pnpm check` and `pnpm verify:boot` pass
