# 11: Calibrate the bot filter on post-migration crash
**Model:** sonnet / high — judgement on thin data; must avoid fitting noise.

**What to build:** The bot-filter thresholds stop being hypotheses. Using the stored raw metrics of labelled migrators, argus measures a post-migration crash per token and the Operator gets a note and a config update with thresholds chosen so the dropped (bot-driven) group is the one that crashes. The choice is then re-checked on a later Cohort. The crash measure starts with DexScreener price change windows (free, crude), and uses pool trades from RPC only if the Helius credits allow. The label stays "organic migration".
Spec: sections 7, 13, 14.

**Blocked by:** 04 Bot-filter raw metrics and the Organic migration label, plus at least one week of labelled migrators

**Status:** ready-for-agent

- [ ] The crash measure (a price drop in the first 20 minutes after migration) is defined, implemented and its data source and gaps are stated
- [ ] A report compares crash rates for the organic and bot-driven groups under the starting thresholds, with counts
- [ ] Thresholds are chosen on one Cohort and re-checked on a later Cohort; both results are in the note, and the held-out Cohort was not used for choosing
- [ ] If the data is too thin to separate the groups, the note says so and the thresholds stay unchanged rather than being tuned
- [ ] Config is updated with the new thresholds, a new threshold version and a pointer to the evidence; old versions stay for history
- [ ] Re-bucketing from stored metrics is run and its counts shown on the Study page, with no recapture and no extra chain calls
- [ ] Credits used by the calibration are reported; any step that spends supports --dry-run
- [ ] Tests cover the crash measure and the re-bucketing
