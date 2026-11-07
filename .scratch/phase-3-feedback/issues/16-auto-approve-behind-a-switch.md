# 16: Auto-approve behind a switch
**Model:** sonnet / high — authorises spend, so the guards matter more than the feature.

**What to build:** When the switch is on, argus approves a Proposal by itself if its score clears a threshold, so a Build can start without the Operator. The approval is recorded with actor system and the reason "Score threshold" through the existing approve path. The switch is off by default, a daily cap bounds how many approvals happen, and dry-run shows what would be approved. This ticket opens only after the 3b gate passed.
Spec: sections 12, 15, 16 (slice 13).

**Blocked by:** 14 3b backtest and the Q20 gate (the gate must have passed)

**Status:** ready-for-agent

- [ ] The switch is off by default in config and in a fresh database; with it off, no auto approval can happen (tested)
- [ ] Approval goes through the existing approve path with actor system and reason "Score threshold"; no second path to a Build exists (tested)
- [ ] The score threshold and the daily cap are config; the cap is counted in code and raising it is a reviewed code change
- [ ] Approvals still respect the existing Build concurrency and spend caps, and the cap blocks the day's extra approvals (tested)
- [ ] Only Proposals with a spec, no collision flag, and not expired are eligible (tested for each exclusion)
- [ ] Each auto approval is visible in the War Room with its actor and reason, and sends a Telegram notice
- [ ] The Operator can turn the switch off at any time and in-flight approvals stop at the next check
- [ ] --dry-run lists what would be approved and makes no state change
- [ ] Full test suite and type-check pass once before the commit
