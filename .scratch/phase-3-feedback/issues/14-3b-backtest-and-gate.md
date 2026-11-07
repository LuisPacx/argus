# 14: 3b backtest and the Q20 gate
**Model:** sonnet / high — statistics on weighted samples with leakage risk.

**What to build:** The Operator gets a pass/fail report on whether the brain's own score finds organic migrators better than chance. A cheap brain score is built from the approved lessons as rules applied at capture time, with no Claude run. It scores later Cohorts blind to labels. The report compares the top decile's organic migration rate against the Cohort's population base rate (with sampling weights, not the oversampled 1:1 rate). The gate passes when the top decile is at least 3 times the base rate in two consecutive later calendar weeks.
Spec: sections 8, 12, 14, 15 (slice 13).

**Blocked by:** 13 3a acceptance run (14 days)

**Status:** ready-for-agent

- [ ] The score is rules derived from approved lessons only, computed from the frozen Snapshot, with no Claude run and no label access (tested)
- [ ] Only Cohorts later than the ones the lessons came from are scored
- [ ] Top-decile rate and base rate use the stored sampling weights; a test with a known oversample shows the weighted result differs from the raw 1:1 rate
- [ ] The gate rule is exactly: ratio at least 3 in two consecutive later calendar weeks; a gap week or a single pass fails (tested)
- [ ] Fast and bot-driven Cases and own launches are kept out of the organic rate, as in the lessons (tested)
- [ ] The report states Cohort sizes and warns when a decile is too small to mean much
- [ ] Output is a pass/fail report saved in the phase-3-feedback directory, and the War Room shows the same result
- [ ] The backtest is read-only over stored data, so it spends nothing and needs no --dry-run, which the report states
