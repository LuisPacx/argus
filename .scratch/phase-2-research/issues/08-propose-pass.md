# 08: Propose pass
**Model:** sonnet / high — turns Scores into Proposals under daily and usage caps.

**What to build:** Narratives above the buildability gate become Proposals through the `propose` task: proposed name, ticker, description, Tech one-liner, "why now" and 3 to 5 evidence links. At most 30 new Proposals per day (raised from 10 on 2026-11-06), and research (judge plus propose) is held to about 30% of the daily subscription usage so it cannot starve Builds. Cards show Score bars and Narrative age.

**Blocked by:** 07

**Status:** done

- [x] A `propose` skill returns validated Proposal fields; evidence links pass the existing link validation
- [x] Only Narratives above the gate are proposed, and each Narrative at most once
- [x] A hard cap of 30 new Proposals per day, in code; tested
- [x] The research usage share (about 30%, measured in Est. usage) is enforced in code and visible in the War Room; when it is reached, research waits for the next day; tested
- [x] Cards show Score bars per dimension, Narrative age, "why now" and the Tech
- [x] The same Brain guarantees as Spec drafting; the fake `claude` in tests
- [x] `pnpm check` and `pnpm verify:boot` pass

Notes: the gate is the latest Score's buildability against the Rubric's gate as it is now (default 5 of 10). Caps: 30 new Proposals per rolling 24 h (enforced inside `createResearchProposal`; config can only lower it), 3 Narratives per pass, 30 propose runs per 24 h, $1 per run. The research share is one rolling-24 h budget of Est. usage shared by judge and propose, `ARGUS_DAILY_QUOTA_USD` x `ARGUS_RESEARCH_SHARE` (default $20 x 0.3 = $6), checked before every run by both passes; it is only as close to "30% of the quota" as the quota estimate is (see architecture section 7). Proposals are made by `Datastore.createResearchProposal` (system actor, `updated_at` = now); `proposePendingNarratives` takes an `onCreated` callback for the Telegram notice (ticket 11). A Narrative's propose run is recorded with `proposal_id` 0 and attached to the Proposal it produces. Not done here: collision checks (ticket 09), the ApiBrain fallback (ticket 12).
