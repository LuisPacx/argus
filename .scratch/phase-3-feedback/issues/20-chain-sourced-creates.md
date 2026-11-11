# 20: Chain-sourced creates (fix the PumpPortal coverage gap)
**Model:** sonnet / high — the sampling must be unbiased and the credit cap must hold; both are easy to get subtly wrong.

**What to build:** PumpPortal's free `subscribeNewToken` misses about 47% of pump.fun creates, mostly the newer `create_v2` shapes (mayhem, cashback flag, BuyV3 or wrapper-paired creates: 88-100% missed; older shapes 1-5%). The Study's population is therefore biased toward old-shape creates, and Phase 4 (which compares migrators with a comparison population) depends on that population being unbiased. The Operator approved fixing it by reading creates from chain, read-only, through Helius. PumpPortal stays the live feed and the migration signal.
Evidence: `.scratch/phase-3-feedback/research/create-coverage-2026-11-11.md` (incl. its "Helius check" section: 264 of 496 creates seen in one 15-minute window) and `.scratch/phase-3-feedback/research/dune-2026-11-11.md`.

Two jobs, one module:

1. **Migrated creates.** For every migration PumpPortal reports (about 800/day), find that mint's create transaction on chain (the earliest successful transaction touching the mint; the create instruction is the pump-program instruction whose `accounts[1]` is the mint-authority PDA `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`), read it with `getTransaction`, and fill the Study create fields and the metadata `uri` that PumpPortal never delivered. Mints PumpPortal already delivered are left alone unless a field is empty.
2. **Comparison sample.** Once a day, list the previous UTC day's successful creates from the mint-authority PDA (`getSignaturesForAddress`, 1,000 per page, failed transactions dropped), draw a uniform random sample (default 2,000, config), read each with `getTransaction`, and store them as the comparison population with their sampling weight. Weight = creates listed that day / creates sampled, stored per row with the day, so Phase 4 can weight back to the full population. Sampled mints that also migrated are kept (the labeller, ticket 03, decides the label); the sample is drawn from all creates, never from "non-migrated" ones, because migration is not known at draw time and filtering on it would bias the sample.

**Blocked by:** 18 ADR 0002 test allows read-only RPC (branch `adr0002-test`; the Helius client is the single module `packages/core/src/study/helius.ts`)

**Status:** ready-for-agent

**Chain access rule (ticket 18):** every chain call goes through `packages/core/src/study/helius.ts`, per-method wrappers only (`getSignaturesForAddress`, `getTransaction`, and, if used, `getTransactionsForAddress`), against the pinned URL `https://mainnet.helius-rpc.com/`. No new file may name the host or an RPC method, and no generic `rpc(method, params)` is exported. This ticket adds wrappers to that module and puts the sampling and parsing logic elsewhere under `packages/core/src/study/`, calling the wrappers. Widening the allowed methods needs the Operator's say-so.

**Credit budget (cited, checked 2026-11-11):**
- Helius Free plan: 1M credits per month, 10 RPC requests per second, no daily limit listed (https://www.helius.dev/pricing). Overage behaviour on Free is not documented there; treat the monthly figure as a hard wall.
- Costs (https://www.helius.dev/docs/billing/credits): `getTransaction` 1 credit, `getSignaturesForAddress` 1 credit, `getTransactionsForAddress` 10 credits minimum (signatures-only flat 10; full transactions 10 per 100 returned).
- Estimate: sample listing ~50 pages (~47k creates/day) + 2,000 reads = ~2,050/day; migrated creates 800 x (1-10 to locate + 1 to read) = about 1,600 to 8,800/day depending on how the earliest signature is found. About 4,000 to 11,000/day, or 120k to 340k/month.
- Default daily cap `chainCreatesDailyCreditCap` = 25,000 credits (750k/month at 30 days), leaving about 250k/month for tickets 03, 04 and 10, which use the same key. If those tickets measure a larger need, the Operator lowers the sample size before raising the cap. Raising the cap above 33,000/day is a reviewed code change, since it breaks the month.
- Sample size `chainCreatesSampleSize` default 2,000/day, config.
- Check the Free figures again at implementation time; if Helius changed them, stop and tell the Operator.

**Open design point for the implementer to settle with a recorded fixture, not a guess:** finding a migrated mint's earliest transaction. `getSignaturesForAddress` on a busy mint needs many pages back to the oldest (1 credit each, but unbounded); `getTransactionsForAddress` with ascending order and limit 1 is 10 credits but bounded. Pick by measured credits on real migrated mints; record the choice in the ticket's Comments.

**Interplay:**
- 02 (snapshots): Snapshots are taken at a fixed age after create. A chain-sourced create found after the fact cannot get a Snapshot at that age, so chain-sourced rows carry create fields and uri only and are marked `source` = `chain_migrated` or `chain_sample`; ticket 02's snapshot job must skip them rather than take a late Snapshot labelled as fixed-age. Whether Phase 4 needs fixed-age Snapshots of the comparison sample is an Operator decision (it would need the sample drawn live, in hourly batches, instead of daily); this ticket records the question and does not decide it.
- 03 (chain labeller): sampled and migrated rows are labelled by the same 24h/7d job; this ticket adds rows, never labels. Both share one credit budget, so credits are logged per job and per day in one place.
- 19 (IPFS gateway fix, written separately): filling `uri` is only useful if metadata can be fetched; 19 owns fetching and gateways, this ticket only fills `uri`. No fetching here.
- 10 (own-launch tracking) and 04 (bot filter): also read chain through `helius.ts`; the daily cap here is separate from any run cap they have, and the monthly total is the thing to watch.
- Phase 4 depends on this population being unbiased: do not drop, dedupe away or re-weight rows beyond the stored weight.

- [ ] Every chain call is a per-method wrapper in `packages/core/src/study/helius.ts` with the pinned URL; `adr-0002.test.ts` passes unchanged, and no other file names the host or an RPC method
- [ ] For each migration PumpPortal reports, the create transaction is fetched and the Study create fields and `uri` are filled; a mint already complete from PumpPortal is not overwritten (tested)
- [ ] Create parsing handles legacy `create`, `create_v2` direct, and wrapper-paired creates (`CreateCoinAndBuyBondingCurveV3`, `CreateCoinAndBuyJupiterBondingCurve`), and mayhem and cashback flags; tested on recorded `helius-*.json` fixtures including each shape, with flag meanings checked against the pinned Pump IDL (the research notes only inferred them from byte positions)
- [ ] Failed transactions are dropped; a transaction that is not a create (for example `CreatePool`) is skipped, not stored as a create (tested)
- [ ] Daily sample: lists the previous UTC day's creates from the mint-authority PDA with pagination, draws a uniform random sample of the configured size using a seeded RNG recorded with the run, and stores each row with `source` = `chain_sample`, the day, and the sampling weight (creates listed / creates sampled); if fewer creates than the sample size exist, all are taken at weight 1
- [ ] The sample is drawn from all creates, not only unmigrated ones; a test shows the sampled share of migrated mints matches the population share on a fixture within tolerance, and the weights sum back to the listed total
- [ ] Rows carry `source` (`pumpportal`, `chain_migrated`, `chain_sample`); a mint reached by two paths is stored once, keeping PumpPortal data and recording both sources
- [ ] A daily credit cap (`chainCreatesDailyCreditCap`, default 25,000) is counted in code from the credit costs above; when reached, the job stops cleanly, leaves nothing half-written, and the unfetched work is retried the next day (tested). The default keeps the month inside the Free plan's 1M credits with room for tickets 03, 04, 10
- [ ] Credits used are logged per run and per UTC day, split by job (migrated creates, sample listing, sample reads) and by method, and the month-to-date total is visible on the Study page or in the run log
- [ ] Requests stay under the Free plan's 10 requests per second (rate limiter, tested with a fake clock); a chain error or rate limit leaves the mint unfilled for retry and writes nothing wrong (tested)
- [ ] The job supports `--dry-run`: it makes no chain call and reports how many mints and how many credits it would use
- [ ] The measured PumpPortal coverage (share of sampled creates PumpPortal also delivered) is stored per day, so the Operator sees if the gap changes
- [ ] The open design point above is settled with measured credits and recorded in Comments
- [ ] Full test suite and type-check pass once before the commit
