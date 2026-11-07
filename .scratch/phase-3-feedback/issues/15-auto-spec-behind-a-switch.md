# 15: Auto-spec behind a switch
**Model:** sonnet / medium — reuses the existing spec draft path behind a switch and a cap.

**What to build:** When the switch is on, argus drafts a build Spec on its own for the top-scored Proposals, so the Operator finds drafts waiting instead of asking for each one. The switch is off by default and a daily cap limits how many drafts run. Approval stays with the Operator. This ticket opens only after the 3b gate passed.
Spec: sections 12, 15 (slice 13).

**Blocked by:** 14 3b backtest and the Q20 gate (the gate must have passed)

**Status:** ready-for-agent

- [ ] The switch is off by default in config and in a fresh database (tested)
- [ ] With the switch on, a draft Spec is created only for Proposals in the top score band set in config, and only once per Proposal (tested)
- [ ] A daily cap counted in code limits drafts; extra qualifying Proposals wait for the next day (tested)
- [ ] Drafts use the existing spec Brain task and its budget, with no new spend path and no API fallback unless the existing path already has one
- [ ] The Operator can see in the War Room which drafts were automatic
- [ ] No approval, build or launch happens as a result of an auto draft (tested)
- [ ] --dry-run lists the Proposals that would get drafts and makes no Claude call
